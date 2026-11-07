/**
 * An organization's branding — `getBranding` (`GET /v1/branding`) and
 * `updateOrganizationBranding` (`PATCH /v1/organizations/{org_id}/branding`).
 *
 * The bodies are the platform's own `BrandingResponse` and problem documents, so these tests pin
 * the wire shape the webapp and the method-app template read. The Python twin is
 * `python/tests/unit/test_client_branding.py`.
 */
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { PipelexApiClient } from "../src/client.js";
import { ApiResponseError } from "../src/errors.js";
import type { LogoRefusalCode } from "../src/errors.js";
import type { OrganizationBranding, OrganizationBrandingUpdate } from "../src/index.js";

const BASE_URL = "http://localhost:8081";
const ORG_ID = "0f6c2a4e-org";
const BRANDING_URL = `${BASE_URL}/v1/organizations/${ORG_ID}/branding`;
/** What a write sends to set a new logo: a standalone upload of the organization. */
const SQUARE_UPLOAD_URI = `pipelex-storage://${ORG_ID}/assets/7d1e.png`;
const WIDE_UPLOAD_URI = `pipelex-storage://${ORG_ID}/assets/9a3c.svg`;
/** What the answer names: the platform's own copy of an accepted logo, under `branding/`. */
const SQUARE_LOGO_URI = `pipelex-storage://${ORG_ID}/branding/3f9a1c2e-5b7d-4e8f-9a0b-1c2d3e4f5a6b.png`;
const WIDE_LOGO_URI = `pipelex-storage://${ORG_ID}/branding/8c7b6a5d-4e3f-4a1b-9c8d-7e6f5a4b3c2d.svg`;

/**
 * A branded team as both routes answer it: one logo, a partial light set, a partial dark set, a
 * style and a typeface.
 */
const BRANDED: OrganizationBranding = {
  org_id: ORG_ID,
  org_name: "Acme Corp",
  colors: { action: "#14213d", accent: "#fca311", header: null },
  dark_colors: { action: null, accent: null, header: "#e5e5e5" },
  square_logo: {
    uri: SQUARE_LOGO_URI,
    sha256: "9b2f6d0c1e4a7b3c5d8e9f0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e",
    content_type: "image/png",
    width: 512.0,
    height: 512.0,
  },
  wide_logo: null,
  style: "editorial",
  typeface: "source-sans-3",
  white_label: false,
};

/**
 * A personal workspace, or a team that set nothing, as the platform answers it, a branding written
 * before the style and the typeface existed included: every colour, logo and choice null.
 */
const UNBRANDED: OrganizationBranding = {
  org_id: ORG_ID,
  org_name: "Ada's workspace",
  colors: { action: null, accent: null, header: null },
  dark_colors: { action: null, accent: null, header: null },
  square_logo: null,
  wide_logo: null,
  style: null,
  typeface: null,
  white_label: false,
};

/** `UNBRANDED` as a platform that predates the style, the typeface and the entitlement answers it. */
const BEFORE_CHOICES = {
  org_id: ORG_ID,
  org_name: "Ada's workspace",
  colors: { action: null, accent: null, header: null },
  dark_colors: { action: null, accent: null, header: null },
  square_logo: null,
  wide_logo: null,
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

function problemResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ status, ...body }), {
    status,
    headers: { "Content-Type": "application/problem+json" },
  });
}

/** The platform's problem document for `code`, as its error handler renders one. */
function problem(
  code: string,
  title: string,
  detail: string,
  errors?: unknown[],
  verdict: { domain: string; retry: string } = { domain: "input", retry: "no" },
) {
  return {
    type: `https://docs.pipelex.com/errors/${code}`,
    title,
    code,
    detail,
    ...verdict,
    next_step: { kind: "change_input", detail: "Change the branding and send it again." },
    instance: "urn:pipelex:request:a9a249b93c024bf08ac9a5fd0704ea92",
    request_id: "a9a249b93c024bf08ac9a5fd0704ea92",
    ...(errors === undefined ? {} : { errors }),
  };
}

/** The item of a refused branding write naming the logo slot or colour key `field`. */
function fieldItem(field: string, detail: string) {
  return { code: "request.invalid", detail, location: { field } };
}

/** The URL, method and parsed body of the single fetch call recorded by the spy. */
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

async function caught(promise: Promise<unknown>): Promise<ApiResponseError> {
  const err = await promise.then(
    () => expect.fail("expected the call to throw"),
    (error: unknown) => error,
  );
  expect(err).toBeInstanceOf(ApiResponseError);
  return err as ApiResponseError;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getBranding", () => {
  it("GETs /v1/branding with no body and hands back the platform's shape", async () => {
    const client = makeClient();
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, BRANDED));

    const branding = await client.getBranding();

    const req = lastRequest(spy);
    expect(req.method).toBe("GET");
    expect(req.url).toBe(`${BASE_URL}/v1/branding`);
    expect(req.body).toBeUndefined();
    expect(branding).toEqual(BRANDED);
    expect(branding.colors.action).toBe("#14213d");
    expect(branding.dark_colors.header).toBe("#e5e5e5");
    expect(branding.square_logo?.width).toBe(512);
    expect(branding.wide_logo).toBeNull();
    expect(branding.style).toBe("editorial");
    expect(branding.typeface).toBe("source-sans-3");
    expect(branding.white_label).toBe(false);
  });

  it("reads an organization with no branding as every colour, logo and choice null", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, UNBRANDED));

    const branding = await client.getBranding();

    expect(branding).toEqual(UNBRANDED);
    expect(branding.org_name).toBe("Ada's workspace");
  });

  it("reads an answer without the choices, as a platform that predates them sends, as unset", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, BEFORE_CHOICES));

    const branding = await client.getBranding();

    // Each member is present and what the type declares, never `undefined`.
    expect(branding).toStrictEqual(UNBRANDED);
    expect(branding.style).toBeNull();
    expect(branding.typeface).toBeNull();
    expect(branding.white_label).toBe(false);
  });

  it("reads the white-label entitlement, which only Pipelex staff grant", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { ...UNBRANDED, white_label: true }),
    );

    const branding = await client.getBranding();

    expect(branding.white_label).toBe(true);
  });

  it.each([
    ["null", { style: null, typeface: null, white_label: null }],
    ["a number", { style: 3, typeface: 4, white_label: 1 }],
    ["an object", { style: { id: "editorial" }, typeface: [], white_label: {} }],
    ["a string where a boolean belongs", { style: null, typeface: null, white_label: "true" }],
  ])(
    "reads a choice sent as %s as unset, and the entitlement as not held",
    async (_topic, choices) => {
      const client = makeClient();
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        jsonResponse(200, { ...BRANDED, ...choices }),
      );

      const branding = await client.getBranding();

      expect(branding).toStrictEqual({
        ...BRANDED,
        style: null,
        typeface: null,
        white_label: false,
      });
    },
  );

  it("keeps an id it does not know, which a client reads as unset", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        ...UNBRANDED,
        style: "a-style-from-next-year",
        typeface: "x".repeat(32),
      }),
    );

    const branding = await client.getBranding();

    expect(branding.style).toBe("a-style-from-next-year");
    expect(branding.typeface).toBe("x".repeat(32));
  });

  it("keeps a member this SDK does not name", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { ...BRANDED, favicon: null }),
    );

    const branding = await client.getBranding();

    expect(branding).toEqual({ ...BRANDED, favicon: null });
  });

  it("types the style, the typeface and the entitlement as always present", () => {
    expectTypeOf<OrganizationBranding["style"]>().toEqualTypeOf<string | null>();
    expectTypeOf<OrganizationBranding["typeface"]>().toEqualTypeOf<string | null>();
    expectTypeOf<OrganizationBranding["white_label"]>().toEqualTypeOf<boolean>();
  });

  it("reads an SVG logo's fractional viewBox size as it was sent", async () => {
    const client = makeClient();
    const body: OrganizationBranding = {
      ...UNBRANDED,
      wide_logo: {
        uri: WIDE_LOGO_URI,
        sha256: "0d1c2b3a49586776a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f00f1e",
        content_type: "image/svg+xml",
        width: 240.5,
        height: 64.25,
      },
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, body));

    const branding = await client.getBranding();

    expect(branding.wide_logo).toEqual(body.wide_logo);
  });

  it("refuses an empty answer as one it cannot read", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    const err = await caught(client.getBranding());

    expect(err.status).toBe(200);
  });
});

describe("updateOrganizationBranding", () => {
  it("PATCHes the organization's branding route and hands back the branding as written", async () => {
    const client = makeClient();
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, BRANDED));

    const branding = await client.updateOrganizationBranding(ORG_ID, {
      colors: { action: "#14213D", accent: "#fca311" },
      square_logo: SQUARE_UPLOAD_URI,
    });

    const req = lastRequest(spy);
    expect(req.method).toBe("PATCH");
    expect(req.url).toBe(BRANDING_URL);
    expect(req.body).toEqual({
      colors: { action: "#14213D", accent: "#fca311" },
      square_logo: SQUARE_UPLOAD_URI,
    });
    expect(branding).toEqual(BRANDED);
    // The answer names the platform's copy of the logo, never the upload the write sent.
    expect(branding.square_logo?.uri).toBe(SQUARE_LOGO_URI);
  });

  it("sends a logo's answered URI back unchanged, which keeps the logo", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => jsonResponse(200, BRANDED));
    const read = await client.getBranding();
    spy.mockClear();

    await client.updateOrganizationBranding(ORG_ID, {
      colors: { header: "#e5e5e5" },
      square_logo: read.square_logo?.uri ?? null,
    });

    expect(lastRequest(spy).body).toEqual({
      colors: { header: "#e5e5e5" },
      square_logo: SQUARE_LOGO_URI,
    });
  });

  it("sends a null to clear and leaves out what it keeps", async () => {
    const client = makeClient();
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, UNBRANDED));

    await client.updateOrganizationBranding(ORG_ID, {
      colors: { header: null },
      dark_colors: null,
      wide_logo: null,
      square_logo: undefined,
    });

    // `undefined` is a key left out, so the platform keeps the square logo.
    expect(lastRequest(spy).body).toEqual({
      colors: { header: null },
      dark_colors: null,
      wide_logo: null,
    });
  });

  it("sends an empty body as an empty object, which writes nothing", async () => {
    const client = makeClient();
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, BRANDED));

    const branding = await client.updateOrganizationBranding(ORG_ID, {});

    expect(lastRequest(spy).body).toEqual({});
    expect(branding).toEqual(BRANDED);
  });

  it("sets a style and a typeface, and hands back the branding as written", async () => {
    const client = makeClient();
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, BRANDED));

    const branding = await client.updateOrganizationBranding(ORG_ID, {
      style: "editorial",
      typeface: "source-sans-3",
    });

    expect(lastRequest(spy).body).toEqual({ style: "editorial", typeface: "source-sans-3" });
    expect(branding.style).toBe("editorial");
    expect(branding.typeface).toBe("source-sans-3");
  });

  it("clears a style with null and keeps the typeface it leaves out", async () => {
    const client = makeClient();
    const answer = { ...BRANDED, style: null };
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, answer));

    const branding = await client.updateOrganizationBranding(ORG_ID, {
      style: null,
      typeface: undefined,
    });

    // `undefined` is a key left out, so the platform keeps the typeface.
    expect(lastRequest(spy).body).toEqual({ style: null });
    expect(branding.style).toBeNull();
    expect(branding.typeface).toBe("source-sans-3");
  });

  it("reads the answer of a platform that predates the choices as getBranding reads it", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, BEFORE_CHOICES));

    const branding = await client.updateOrganizationBranding(ORG_ID, { colors: null });

    expect(branding).toStrictEqual(UNBRANDED);
  });

  it("types every key of the update as optional and nullable, white_label not among them", () => {
    expectTypeOf<OrganizationBrandingUpdate>().toEqualTypeOf<{
      colors?: { action?: string | null; accent?: string | null; header?: string | null } | null;
      dark_colors?: {
        action?: string | null;
        accent?: string | null;
        header?: string | null;
      } | null;
      square_logo?: string | null;
      wide_logo?: string | null;
      style?: string | null;
      typeface?: string | null;
    }>();
    // The entitlement is Pipelex staff's to grant: no branding write names it.
    expectTypeOf<OrganizationBrandingUpdate>().not.toHaveProperty("white_label");
  });

  it.each([
    ["a colour that is not #rrggbb", "dark_colors.header", { dark_colors: { header: "#14213g" } }],
    ["a style of the wrong shape", "style", { style: "Editorial" }],
    ["a typeface of the wrong shape", "typeface", { typeface: "source sans" }],
    [
      "the white-label entitlement, which only Pipelex staff set",
      "white_label",
      { white_label: true },
    ],
  ])("hands back the refusal of %s, naming the field", async (_topic, field, input) => {
    const client = makeClient();
    // A lone refused field is the problem's own: no `errors`, the field in `params` and `location`.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      problemResponse(422, {
        ...problem("request.invalid", "Invalid request", "The request body is invalid."),
        params: { field },
        location: { field },
      }),
    );

    const err = await caught(
      client.updateOrganizationBranding(ORG_ID, input as OrganizationBrandingUpdate),
    );

    expect(err.status).toBe(422);
    expect(err.code).toBe("request.invalid");
    expect(err.problem.params).toEqual({ field });
    expect(err.problem.location?.field).toBe(field);
    expect(err.problem.errors).toBeUndefined();
  });

  it("names the logo refusal codes the platform sends", () => {
    expectTypeOf<LogoRefusalCode>().toEqualTypeOf<
      | "logo_not_an_upload"
      | "logo_not_found"
      | "logo_too_large"
      | "logo_type_not_accepted"
      | "logo_unreadable"
      | "logo_active_content"
      | "logo_not_square"
      | "logo_too_small"
      | "logo_not_wide"
      | "logo_too_short"
    >();
  });

  it("hands both slots' logo refusals to the caller, each with the sentence for its slot", async () => {
    const client = makeClient();
    const squareDetail =
      "The square logo is 100 × 100 px; a square logo must be at least 128 px on each side.";
    const wideDetail = "The wide logo is 240 × 48 px; a wide logo must be at least 64 px tall.";
    const errors = [fieldItem("square_logo", squareDetail), fieldItem("wide_logo", wideDetail)];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      problemResponse(
        422,
        problem("request.invalid", "Invalid request", `${squareDetail} ${wideDetail}`, errors),
      ),
    );

    const err = await caught(
      client.updateOrganizationBranding(ORG_ID, {
        square_logo: SQUARE_UPLOAD_URI,
        wide_logo: WIDE_UPLOAD_URI,
      }),
    );

    expect(err.status).toBe(422);
    expect(err.code).toBe("request.invalid");
    expect(err.domain).toBe("input");
    expect(err.retry).toBe("no");
    expect(err.problem.errors).toEqual(errors);
    // What the settings screen does: one slot's sentences, read by the slot's key.
    const underSquare = err.problem.errors?.filter(
      (entry) => entry.location?.field === "square_logo",
    );
    expect(underSquare?.map((entry) => entry.detail)).toEqual([squareDetail]);
  });

  /** The platform's sentence for a URI a slot may not take (`not_an_upload_refusal`). */
  const notAnUpload = (slot: string) =>
    `The ${slot} must be a newly uploaded file (pipelex-storage://<organization>/assets/<file>) or the URI the ${slot} already has.`;

  /** The platform's sentence for an SVG's active content, `what` being the construct it names. */
  const activeContent = (slot: string, what: string) =>
    `The ${slot} is an SVG that carries active content, which a logo may not: ${what}.`;

  /** The tail of the platform's sentence for a link that leaves the file, an `href` or a CSS one. */
  const INERT_LINKS_ONLY =
    "where only a reference inside it or an embedded PNG, JPEG, GIF or WebP image is allowed";

  it.each([
    [
      "an SVG carrying active content",
      "wide_logo",
      WIDE_UPLOAD_URI,
      "The wide logo is an SVG that carries active content, which a logo may not: a <script> element.",
    ],
    [
      "a branding copy no slot holds",
      "wide_logo",
      `pipelex-storage://${ORG_ID}/branding/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d.svg`,
      notAnUpload("wide logo"),
    ],
    [
      "the other slot's logo, which cannot move by its URI",
      "wide_logo",
      SQUARE_LOGO_URI,
      notAnUpload("wide logo"),
    ],
    [
      "a raster past the pixel cap",
      "square_logo",
      SQUARE_UPLOAD_URI,
      "The square logo looks like a PNG image but cannot be read: at 5,000 × 5,000 px it has more than the 16,777,216 pixels (4096 × 4096) a logo may have.",
    ],
    [
      "a raster cut short",
      "square_logo",
      SQUARE_UPLOAD_URI,
      "The square logo looks like a JPEG image but cannot be read: the file is damaged or incomplete.",
    ],
    [
      "an animated WebP, since a logo is a still image",
      "square_logo",
      SQUARE_UPLOAD_URI,
      "The square logo is an animated WebP; a logo must be a still image.",
    ],
    [
      "an animated PNG, since a logo is a still image",
      "wide_logo",
      WIDE_UPLOAD_URI,
      "The wide logo is an animated PNG; a logo must be a still image.",
    ],
    [
      "an SVG whose width and height lie outside the range a side may measure",
      "square_logo",
      SQUARE_UPLOAD_URI,
      "The square logo is an SVG that cannot be read: its width or height lies outside the 0.001 to 1,000,000 px a logo's side may measure.",
    ],
    [
      "an SVG whose viewBox lies outside the range a side may measure",
      "wide_logo",
      WIDE_UPLOAD_URI,
      "The wide logo is an SVG that cannot be read: its viewBox's width or height lies outside the 0.001 to 1,000,000 units a logo's side may measure.",
    ],
    [
      "an SVG with an xml-stylesheet processing instruction",
      "square_logo",
      SQUARE_UPLOAD_URI,
      activeContent(
        "square logo",
        "an xml-stylesheet processing instruction, which loads a style sheet",
      ),
    ],
    [
      "an SVG whose CSS imports a style sheet",
      "square_logo",
      SQUARE_UPLOAD_URI,
      activeContent("square logo", "a CSS @import, which loads a style sheet"),
    ],
    [
      "an SVG whose CSS url() leaves the file",
      "wide_logo",
      WIDE_UPLOAD_URI,
      activeContent(
        "wide logo",
        `a CSS url() that links to something outside the file, ${INERT_LINKS_ONLY}`,
      ),
    ],
    [
      "an SVG whose CSS src() leaves the file",
      "square_logo",
      SQUARE_UPLOAD_URI,
      activeContent(
        "square logo",
        `a CSS src() that links to something outside the file, ${INERT_LINKS_ONLY}`,
      ),
    ],
    [
      "an SVG whose CSS holds an image-set()",
      "square_logo",
      SQUARE_UPLOAD_URI,
      activeContent(
        "square logo",
        "a CSS image-set() function, which can load an image from outside the file",
      ),
    ],
    [
      "an SVG whose CSS holds an image()",
      "wide_logo",
      WIDE_UPLOAD_URI,
      activeContent(
        "wide logo",
        "a CSS image() function, which can load an image from outside the file",
      ),
    ],
    [
      "an SVG whose CSS holds an escape",
      "square_logo",
      SQUARE_UPLOAD_URI,
      activeContent("square logo", "a CSS escape (a backslash), which can disguise a link"),
    ],
  ])("refuses %s under its slot", async (_topic, field, uri, detail) => {
    const client = makeClient();
    const errors = [fieldItem(field, detail)];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      problemResponse(422, problem("request.invalid", "Invalid request", detail, errors)),
    );

    const err = await caught(client.updateOrganizationBranding(ORG_ID, { [field]: uri }));

    expect(err.code).toBe("request.invalid");
    expect(err.problem.errors).toEqual(errors);
  });

  it("hands back a storage failure while reading or copying a logo as a retryable 503", async () => {
    const client = makeClient();
    const detail = "Storage backend failure while storing a logo.";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      problemResponse(
        503,
        problem("runtime.unavailable", "Unavailable", detail, undefined, {
          domain: "runtime",
          retry: "yes",
        }),
      ),
    );

    const err = await caught(
      client.updateOrganizationBranding(ORG_ID, { square_logo: SQUARE_UPLOAD_URI }),
    );

    expect(err.status).toBe(503);
    expect(err.code).toBe("runtime.unavailable");
    expect(err.domain).toBe("runtime");
    expect(err.retry).toBe("yes");
    expect(err.problem.errors).toBeUndefined();
  });

  it("names several refused fields each in an item, a colour by its dotted key", async () => {
    const client = makeClient();
    const errors = [
      fieldItem("dark_colors.header", "String should match pattern '^#[0-9a-fA-F]{6}$'"),
      fieldItem("style", "String should match pattern '^[a-z0-9-]{1,32}$'"),
    ];
    // Several refused fields: the problem names the first, and each has its item in `errors`.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      problemResponse(422, {
        ...problem(
          "request.invalid",
          "Invalid request",
          "Request body failed validation. See `errors` for the per-field breakdown.",
          errors,
        ),
        params: { field: "dark_colors.header" },
        location: { field: "dark_colors.header" },
      }),
    );

    const err = await caught(
      client.updateOrganizationBranding(ORG_ID, {
        dark_colors: { header: "#14213g" },
        style: "Editorial",
      }),
    );

    expect(err.code).toBe("request.invalid");
    expect(err.problem.errors).toEqual(errors);
    expect(err.problem.errors?.map((item) => item.location?.field)).toEqual([
      "dark_colors.header",
      "style",
    ]);
  });

  it.each([
    [
      422,
      "pipelex.storage.uri_invalid",
      "Invalid storage URI",
      "The square logo is not a valid storage URI: Storage URI must start with pipelex-storage://",
    ],
    [
      403,
      "pipelex.org.mismatch",
      "Organization mismatch",
      "The square logo is a file of a different organization.",
    ],
  ])(
    "names the slot of a logo URI refused before any read (%i %s)",
    async (status, code, title, detail) => {
      const client = makeClient();
      const errors = [{ code, detail, location: { field: "square_logo" } }];
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        problemResponse(status, problem(code, title, detail, errors)),
      );

      const err = await caught(
        client.updateOrganizationBranding(ORG_ID, { square_logo: "https://example.com/logo.png" }),
      );

      expect(err.status).toBe(status);
      expect(err.code).toBe(code);
      expect(err.problem.errors).toEqual(errors);
    },
  );

  it.each([
    [
      403,
      "auth.forbidden",
      "Forbidden",
      "Your role in this organization is runner: it runs the organization's published versions and changes no branding.",
    ],
    [
      409,
      "pipelex.org.not_manageable",
      "Organization not manageable",
      "A personal workspace has no branding: logos and colours belong to a team organization.",
    ],
    [404, "pipelex.org.not_found", "Organization not found", "Organization not found"],
  ])("refuses a write the platform refuses (%i %s)", async (status, code, title, detail) => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      problemResponse(status, problem(code, title, detail)),
    );

    const err = await caught(client.updateOrganizationBranding(ORG_ID, { colors: null }));

    expect(err.status).toBe(status);
    expect(err.code).toBe(code);
    expect(err.problem.detail).toBe(detail);
    expect(err.problem.errors).toBeUndefined();
  });
});
