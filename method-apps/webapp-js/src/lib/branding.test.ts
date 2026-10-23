import { describe, expect, it } from "vitest";
import { brandingFromApi, isLogoDigest, logoPath, organizationLogos } from "@/lib/branding";
import { BRANDED, SQUARE_LOGO, UNBRANDED, WIDE_LOGO, branding } from "@/test/fixtures/branding";
import { SITE } from "@/site";

describe("brandingFromApi", () => {
  it("leaves an app unbranded when the read failed or the team set nothing", () => {
    expect(brandingFromApi(null)).toBeNull();
    expect(brandingFromApi(undefined)).toBeNull();
    expect(brandingFromApi("branding")).toBeNull();
    // The name alone brands nothing: every organization has one.
    expect(brandingFromApi(UNBRANDED)).toBeNull();
  });

  it("brands an app with a single colour, in either set, or a single logo", () => {
    expect(
      brandingFromApi(branding({ colors: { action: "#14213D", accent: null, header: null } })),
    ).not.toBeNull();
    expect(
      brandingFromApi(branding({ dark_colors: { action: null, accent: null, header: "#000000" } })),
    ).not.toBeNull();
    expect(brandingFromApi(branding({ square_logo: SQUARE_LOGO }))).not.toBeNull();
  });

  it("keeps the colours in lower case, and the name as the logo's alt and the wordmark", () => {
    const result = brandingFromApi(
      branding({ org_name: "  Acme  ", colors: { action: "#14213D", accent: null, header: null } }),
    );
    expect(result?.orgName).toBe("Acme");
    expect(result?.light).toEqual({ action: "#14213d", accent: null, header: null });
  });

  it("names the band after the app when the organization's name is blank or missing", () => {
    for (const org_name of ["", "   ", undefined]) {
      const result = brandingFromApi(
        branding({ org_name: org_name as never, wide_logo: WIDE_LOGO }),
      );
      expect(result?.orgName).toBe(SITE.title);
    }
  });

  it("treats a colour that is not #rrggbb as unset, so nothing the API sends breaks the page", () => {
    const result = brandingFromApi(
      branding({
        colors: {
          action: "red",
          accent: "#fca3111",
          header: "#14213d;}body{display:none",
        } as never,
        square_logo: SQUARE_LOGO,
      }),
    );
    expect(result?.light).toEqual({ action: null, accent: null, header: null });
  });

  it("resolves the dark set colour by colour from the light one", () => {
    const result = brandingFromApi(
      branding({
        colors: { action: "#14213d", accent: "#fca311", header: "#14213d" },
        dark_colors: { action: "#fca311", accent: null, header: null },
      }),
    );
    expect(result?.dark).toEqual({ action: "#fca311", accent: "#fca311", header: "#14213d" });
  });

  it("puts a logo on a white tile in dark only when the dark theme has no header colour", () => {
    // No header colour in either set: the dark band is the dark page.
    expect(brandingFromApi(branding({ wide_logo: WIDE_LOGO }))?.tileInDark).toBe(true);
    // A light header colour carries into dark.
    expect(
      brandingFromApi(
        branding({
          wide_logo: WIDE_LOGO,
          colors: { action: null, accent: null, header: "#14213d" },
        }),
      )?.tileInDark,
    ).toBe(false);
    // A dark one alone does too.
    expect(
      brandingFromApi(
        branding({
          wide_logo: WIDE_LOGO,
          dark_colors: { action: null, accent: null, header: "#1f2937" },
        }),
      )?.tileInDark,
    ).toBe(false);
  });

  it("orders the logos wide then square, each served by its digest with its shape", () => {
    const result = brandingFromApi(BRANDED);
    expect(result?.logos).toEqual([
      { src: `/api/branding/logo/${WIDE_LOGO.sha256}`, width: 400, height: 100 },
      { src: `/api/branding/logo/${SQUARE_LOGO.sha256}`, width: 100, height: 100 },
    ]);
  });

  it("keeps an SVG's fractional shape as a ratio, never rounded to nothing", () => {
    const result = brandingFromApi(
      branding({
        wide_logo: { ...WIDE_LOGO, content_type: "image/svg+xml", width: 1, height: 0.25 },
      }),
    );
    expect(result?.logos[0]).toMatchObject({ width: 400, height: 100 });
  });

  it("leaves out a logo whose description is incomplete, and never serves its URI", () => {
    for (const broken of [
      { ...WIDE_LOGO, sha256: "not-a-digest" },
      { ...WIDE_LOGO, uri: "https://example.com/logo.png" },
      { ...WIDE_LOGO, content_type: "image/gif" },
      { ...WIDE_LOGO, width: 0 },
      { ...WIDE_LOGO, height: Number.NaN },
    ]) {
      const result = brandingFromApi(branding({ wide_logo: broken, square_logo: SQUARE_LOGO }));
      expect(result?.logos.map((logo) => logo.src)).toEqual([logoPath(SQUARE_LOGO.sha256)]);
    }
    // The only logo, incomplete, leaves the team unbranded.
    expect(brandingFromApi(branding({ wide_logo: { ...WIDE_LOGO, width: -1 } }))).toBeNull();
  });
});

describe("organizationLogos", () => {
  it("lists the complete logos, wide first, with their storage references", () => {
    expect(organizationLogos(BRANDED)).toEqual([
      {
        uri: WIDE_LOGO.uri,
        sha256: WIDE_LOGO.sha256,
        contentType: "image/png",
        width: 640,
        height: 160,
      },
      {
        uri: SQUARE_LOGO.uri,
        sha256: SQUARE_LOGO.sha256,
        contentType: "image/png",
        width: 256,
        height: 256,
      },
    ]);
    expect(organizationLogos(null)).toEqual([]);
    expect(organizationLogos(UNBRANDED)).toEqual([]);
  });
});

describe("isLogoDigest", () => {
  it("accepts 64 lower-case hexadecimal digits and nothing else", () => {
    expect(isLogoDigest(WIDE_LOGO.sha256)).toBe(true);
    expect(isLogoDigest(WIDE_LOGO.sha256.toUpperCase())).toBe(false);
    expect(isLogoDigest(WIDE_LOGO.sha256.slice(1))).toBe(false);
    expect(isLogoDigest(`${WIDE_LOGO.sha256}/../x`)).toBe(false);
    expect(isLogoDigest(42)).toBe(false);
  });
});
