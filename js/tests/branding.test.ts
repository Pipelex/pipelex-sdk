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
import type {
  BrandingDesignSystem,
  OrganizationBranding,
  OrganizationBrandingUpdate,
} from "../src/index.js";

const BASE_URL = "http://localhost:8081";
const ORG_ID = "0f6c2a4e-org";
const BRANDING_URL = `${BASE_URL}/v1/organizations/${ORG_ID}/branding`;
/** What a write sends to set a new logo: a standalone upload of the organization. */
const SQUARE_UPLOAD_URI = `pipelex-storage://${ORG_ID}/assets/7d1e.png`;
const WIDE_UPLOAD_URI = `pipelex-storage://${ORG_ID}/assets/9a3c.svg`;
/** What the answer names: the platform's own copy of an accepted logo, under `branding/`. */
const SQUARE_LOGO_URI = `pipelex-storage://${ORG_ID}/branding/3f9a1c2e-5b7d-4e8f-9a0b-1c2d3e4f5a6b.png`;
const WIDE_LOGO_URI = `pipelex-storage://${ORG_ID}/branding/8c7b6a5d-4e3f-4a1b-9c8d-7e6f5a4b3c2d.svg`;
const DARK_SQUARE_LOGO_URI = `pipelex-storage://${ORG_ID}/branding/5e4d3c2b-1a09-4f8e-8d7c-6b5a49382716.png`;

/** A design system, a DTCG token document, cut down to a colour and the preset it started from. */
const DESIGN_SYSTEM: BrandingDesignSystem = {
  color: {
    $type: "color",
    primary: { $value: { colorSpace: "srgb", components: [0.08, 0.13, 0.24] } },
  },
  $extensions: { "com.pipelex.preset": { id: "corporate" } },
};

/**
 * A branded team as both routes answer it: a square logo with its dark variant, a partial light
 * set, a partial dark set, a preset, a shell, a typeface and a design system.
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
  dark_square_logo: {
    uri: DARK_SQUARE_LOGO_URI,
    sha256: "4e5f60718293a4b5c6d7e8f90a1b2c3d4e9b2f6d0c1e4a7b3c5d8e9f0a1b2c3d",
    content_type: "image/png",
    width: 512.0,
    height: 512.0,
  },
  dark_wide_logo: null,
  preset: "corporate",
  shell: "masthead",
  typeface: "source-sans-3",
  design_system: DESIGN_SYSTEM,
  white_label: false,
};

/**
 * A personal workspace, or a team that set nothing, as the platform answers it, a branding written
 * before the kit's newer fields existed included: every colour, logo and choice null, and no
 * design system.
 */
const UNBRANDED: OrganizationBranding = {
  org_id: ORG_ID,
  org_name: "Ada's workspace",
  colors: { action: null, accent: null, header: null },
  dark_colors: { action: null, accent: null, header: null },
  square_logo: null,
  wide_logo: null,
  dark_square_logo: null,
  dark_wide_logo: null,
  preset: null,
  shell: null,
  typeface: null,
  design_system: null,
  white_label: false,
};

/**
 * `UNBRANDED` as a platform that predates the dark logos, the choices, the design system and the
 * entitlement answers it.
 */
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

const UNSUPPORTED_TITLE = "The request uses a form this runtime does not accept";

/** The code's own sentence for a refused logo: the measured sentence goes to the platform's logs. */
function unsupportedDetail(field: string, reason: string): string {
  return `This runtime does not accept the form the request's field '${field}' uses (reason: ${reason}).`;
}

/** One broken rule of a logo refusal with several, as an item of its `errors`. */
function logoRefusalItem(field: string, reason: LogoRefusalCode) {
  return {
    code: "request.unsupported",
    detail: unsupportedDetail(field, reason),
    params: { field, reason },
    location: { field },
  };
}

/** Each logo refusal of `err` as its slot and reason: its `errors` when it has some, else the problem. */
function refusalReasons(err: ApiResponseError): [string | undefined, unknown][] {
  const refusals = err.problem.errors ?? [err.problem];
  return refusals.map((item) => [item.location?.field, item.params?.reason]);
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
    expect(branding.dark_square_logo?.uri).toBe(DARK_SQUARE_LOGO_URI);
    expect(branding.dark_wide_logo).toBeNull();
    expect(branding.preset).toBe("corporate");
    expect(branding.shell).toBe("masthead");
    expect(branding.typeface).toBe("source-sans-3");
    expect(branding.design_system).toEqual(DESIGN_SYSTEM);
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
    expect(branding.dark_square_logo).toBeNull();
    expect(branding.dark_wide_logo).toBeNull();
    expect(branding.preset).toBeNull();
    expect(branding.shell).toBeNull();
    expect(branding.typeface).toBeNull();
    expect(branding.design_system).toBeNull();
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
    ["null", { preset: null, shell: null, typeface: null, design_system: null, white_label: null }],
    ["a number", { preset: 3, shell: 5, typeface: 4, design_system: 6, white_label: 1 }],
    [
      "an object or an array",
      { preset: { id: "corporate" }, shell: [], typeface: [], design_system: [], white_label: {} },
    ],
    [
      "a string where a boolean or a document belongs",
      {
        preset: null,
        shell: null,
        typeface: null,
        design_system: '{"color":{}}',
        white_label: "true",
      },
    ],
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
        preset: null,
        shell: null,
        typeface: null,
        design_system: null,
        white_label: false,
      });
    },
  );

  it("keeps an id it does not know as it came, for the application to read as unset", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        ...UNBRANDED,
        preset: "a-preset-from-next-year",
        shell: "a-shell-from-next-year",
        typeface: "x".repeat(32),
      }),
    );

    const branding = await client.getBranding();

    expect(branding.preset).toBe("a-preset-from-next-year");
    expect(branding.shell).toBe("a-shell-from-next-year");
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

  it("types the dark logos, the choices, the design system and the entitlement as always present", () => {
    expectTypeOf<OrganizationBranding["dark_square_logo"]>().toEqualTypeOf<
      OrganizationBranding["square_logo"]
    >();
    expectTypeOf<OrganizationBranding["dark_wide_logo"]>().toEqualTypeOf<
      OrganizationBranding["wide_logo"]
    >();
    expectTypeOf<OrganizationBranding["preset"]>().toEqualTypeOf<string | null>();
    expectTypeOf<OrganizationBranding["shell"]>().toEqualTypeOf<string | null>();
    expectTypeOf<OrganizationBranding["typeface"]>().toEqualTypeOf<string | null>();
    expectTypeOf<OrganizationBranding["design_system"]>().toEqualTypeOf<Record<
      string,
      unknown
    > | null>();
    expectTypeOf<OrganizationBranding["white_label"]>().toEqualTypeOf<boolean>();
    // The preset replaced the app style, which the platform no longer answers.
    expectTypeOf<OrganizationBranding>().not.toHaveProperty("style");
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

  it("sets a preset, a shell and a typeface, and hands back the branding as written", async () => {
    const client = makeClient();
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, BRANDED));

    const branding = await client.updateOrganizationBranding(ORG_ID, {
      preset: "corporate",
      shell: "masthead",
      typeface: "source-sans-3",
    });

    expect(lastRequest(spy).body).toEqual({
      preset: "corporate",
      shell: "masthead",
      typeface: "source-sans-3",
    });
    expect(branding.preset).toBe("corporate");
    expect(branding.shell).toBe("masthead");
    expect(branding.typeface).toBe("source-sans-3");
  });

  it("clears a preset with null and keeps the choices it leaves out", async () => {
    const client = makeClient();
    const answer = { ...BRANDED, preset: null };
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, answer));

    const branding = await client.updateOrganizationBranding(ORG_ID, {
      preset: null,
      typeface: undefined,
    });

    // `undefined` is a key left out, so the platform keeps the typeface.
    expect(lastRequest(spy).body).toEqual({ preset: null });
    expect(branding.preset).toBeNull();
    expect(branding.shell).toBe("masthead");
    expect(branding.typeface).toBe("source-sans-3");
  });

  it("sets and removes a dark logo, and hands back the platform's copy", async () => {
    const client = makeClient();
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, BRANDED));

    const branding = await client.updateOrganizationBranding(ORG_ID, {
      dark_square_logo: SQUARE_UPLOAD_URI,
      dark_wide_logo: null,
    });

    expect(lastRequest(spy).body).toEqual({
      dark_square_logo: SQUARE_UPLOAD_URI,
      dark_wide_logo: null,
    });
    // The answer names the platform's copy of the dark logo, never the upload the write sent.
    expect(branding.dark_square_logo?.uri).toBe(DARK_SQUARE_LOGO_URI);
  });

  it("sends the design system whole, and removes it with null", async () => {
    const client = makeClient();
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(200, BRANDED))
      .mockResolvedValueOnce(jsonResponse(200, { ...BRANDED, design_system: null }));

    const written = await client.updateOrganizationBranding(ORG_ID, {
      design_system: DESIGN_SYSTEM,
    });
    expect(lastRequest(spy).body).toEqual({ design_system: DESIGN_SYSTEM });
    expect(written.design_system).toEqual(DESIGN_SYSTEM);
    spy.mockClear();

    const removed = await client.updateOrganizationBranding(ORG_ID, { design_system: null });
    expect(lastRequest(spy).body).toEqual({ design_system: null });
    expect(removed.design_system).toBeNull();
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
      dark_square_logo?: string | null;
      dark_wide_logo?: string | null;
      preset?: string | null;
      shell?: string | null;
      typeface?: string | null;
      design_system?: Record<string, unknown> | null;
    }>();
    // The entitlement is Pipelex staff's to grant: no branding write names it.
    expectTypeOf<OrganizationBrandingUpdate>().not.toHaveProperty("white_label");
    // The preset replaced the app style, which the platform refuses as a key it does not know.
    expectTypeOf<OrganizationBrandingUpdate>().not.toHaveProperty("style");
  });

  it.each([
    ["a colour that is not #rrggbb", "dark_colors.header", { dark_colors: { header: "#14213g" } }],
    ["a preset of the wrong shape", "preset", { preset: "Corporate" }],
    ["a shell of the wrong shape", "shell", { shell: "master_head" }],
    ["a typeface of the wrong shape", "typeface", { typeface: "source sans" }],
    [
      "a design system of the wrong shape",
      "design_system",
      { design_system: { color: { "a.b": {} } } },
    ],
    ["the retired app style", "style", { style: "editorial" }],
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

  it("names each broken rule of the logos by its slot and reason, the first on the problem", async () => {
    const client = makeClient();
    const errors = [
      logoRefusalItem("square_logo", "logo_too_small"),
      logoRefusalItem("dark_wide_logo", "logo_too_short"),
    ];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      problemResponse(422, {
        ...problem(
          "request.unsupported",
          UNSUPPORTED_TITLE,
          unsupportedDetail("square_logo", "logo_too_small"),
          errors,
        ),
        params: { field: "square_logo", reason: "logo_too_small" },
        location: { field: "square_logo" },
      }),
    );

    const err = await caught(
      client.updateOrganizationBranding(ORG_ID, {
        square_logo: SQUARE_UPLOAD_URI,
        dark_wide_logo: WIDE_UPLOAD_URI,
      }),
    );

    expect(err.status).toBe(422);
    expect(err.code).toBe("request.unsupported");
    expect(err.domain).toBe("input");
    expect(err.retry).toBe("no");
    expect(err.problem.params).toEqual({ field: "square_logo", reason: "logo_too_small" });
    expect(err.problem.errors).toEqual(errors);
    expect(refusalReasons(err)).toEqual([
      ["square_logo", "logo_too_small"],
      ["dark_wide_logo", "logo_too_short"],
    ]);
  });

  it.each<[string, string, string, LogoRefusalCode]>([
    ["an SVG carrying active content", "wide_logo", WIDE_UPLOAD_URI, "logo_active_content"],
    [
      "a branding copy no slot holds",
      "wide_logo",
      `pipelex-storage://${ORG_ID}/branding/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d.svg`,
      "logo_not_an_upload",
    ],
    [
      "the other slot's logo, which cannot move by its URI",
      "wide_logo",
      SQUARE_LOGO_URI,
      "logo_not_an_upload",
    ],
    [
      "the light logo in its dark slot, a dark logo being held to its slot's rules",
      "dark_square_logo",
      SQUARE_LOGO_URI,
      "logo_not_an_upload",
    ],
    ["an upload that is not there", "square_logo", SQUARE_UPLOAD_URI, "logo_not_found"],
    ["a file over 1 MiB", "square_logo", SQUARE_UPLOAD_URI, "logo_too_large"],
    ["a raster that cannot be read", "square_logo", SQUARE_UPLOAD_URI, "logo_unreadable"],
    [
      "an animated PNG, since a logo is a still image",
      "wide_logo",
      WIDE_UPLOAD_URI,
      "logo_type_not_accepted",
    ],
    ["a square logo that is not square", "square_logo", SQUARE_UPLOAD_URI, "logo_not_square"],
    ["a wide logo that is not wide", "wide_logo", WIDE_UPLOAD_URI, "logo_not_wide"],
  ])(
    "refuses %s, the problem itself naming the slot and the reason",
    async (_topic, field, uri, reason) => {
      const client = makeClient();
      // One broken rule: the problem itself names it, and carries no `errors`.
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        problemResponse(422, {
          ...problem("request.unsupported", UNSUPPORTED_TITLE, unsupportedDetail(field, reason)),
          params: { field, reason },
          location: { field },
        }),
      );

      const err = await caught(client.updateOrganizationBranding(ORG_ID, { [field]: uri }));

      expect(err.code).toBe("request.unsupported");
      expect(err.problem.errors).toBeUndefined();
      expect(refusalReasons(err)).toEqual([[field, reason]]);
    },
  );

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
      fieldItem("preset", "String should match pattern '^[a-z0-9-]{1,32}$'"),
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
        preset: "Corporate",
      }),
    );

    expect(err.code).toBe("request.invalid");
    expect(err.problem.errors).toEqual(errors);
    expect(err.problem.errors?.map((item) => item.location?.field)).toEqual([
      "dark_colors.header",
      "preset",
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
      // Refused before any file is read: the problem itself names the slot, with no `errors`.
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        problemResponse(status, {
          ...problem(code, title, detail),
          location: { field: "square_logo" },
        }),
      );

      const err = await caught(
        client.updateOrganizationBranding(ORG_ID, { square_logo: "https://example.com/logo.png" }),
      );

      expect(err.status).toBe(status);
      expect(err.code).toBe(code);
      expect(err.problem.errors).toBeUndefined();
      expect(err.problem.location?.field).toBe("square_logo");
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
