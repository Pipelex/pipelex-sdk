import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { contrastRatio, deriveBrandRoles } from "@pipelex/mthds-form/brand";
import {
  brandStyleSheet,
  brandTokens,
  PAGE_COLORS,
  type BrandTokenName,
  type BrandTokens,
} from "@/lib/brandStyle";

const NAVY = "#14213d";
const AMBER = "#fca311";

function srgb(hex: string) {
  const channel = (at: number) => parseInt(hex.slice(at, at + 2), 16) / 255;
  return {
    colorSpace: "srgb" as const,
    components: [channel(1), channel(3), channel(5)] as [number, number, number],
    alpha: 1,
  };
}

function contrast(a: string, b: string): number {
  return contrastRatio(srgb(a), srgb(b));
}

/** One token the seeds must have produced: a missing one fails the test by name. */
function token(tokens: BrandTokens, name: BrandTokenName): string {
  const value = tokens[name];
  if (value === undefined) throw new Error(`${name} was not written`);
  return value;
}

/** The declarations of one rule of the sheet, as a name-to-value map. */
function rule(sheet: string, selector: string): Record<string, string> {
  const match = sheet.match(new RegExp(`^${selector.replace(".", "\\.")}\\{([^}]*)\\}$`, "m"));
  if (match === null) throw new Error(`no ${selector} rule in ${sheet}`);
  return Object.fromEntries(
    match[1]!
      .split(";")
      .filter(Boolean)
      .map((declaration) => declaration.split(":") as [string, string]),
  );
}

describe("brandTokens", () => {
  it("maps the button colour onto --primary as a fill, with black or white on it", () => {
    const tokens = brandTokens({ action: NAVY }, PAGE_COLORS.light);
    expect(token(tokens, "--primary")).toBe(NAVY);
    expect(tokens["--primary-foreground"]).toBe("#ffffff");
    expect(brandTokens({ action: AMBER }, PAGE_COLORS.light)["--primary-foreground"]).toBe(
      "#000000",
    );
  });

  it("puts the accent's ink on --link, never the raw accent, so accent text always reads", () => {
    const tokens = brandTokens({ action: NAVY, accent: AMBER }, PAGE_COLORS.light);
    const link = token(tokens, "--link");
    // Amber on the light page is a fill, not a text colour: the ink is a deeper amber.
    expect(contrast(AMBER, PAGE_COLORS.light)).toBeLessThan(4.5);
    expect(link).not.toBe(AMBER);
    expect(contrast(link, PAGE_COLORS.light)).toBeGreaterThanOrEqual(4.5);
    // The ink on the selected fill, the kernel's selected pill and this app's run status.
    expect(contrast(link, token(tokens, "--selected"))).toBeGreaterThanOrEqual(4.5);
  });

  it("draws focus in the accent's ink, so a branded focus reads against the page", () => {
    const tokens = brandTokens({ action: NAVY, accent: AMBER }, PAGE_COLORS.light);
    expect(token(tokens, "--ring")).toBe(token(tokens, "--link"));
  });

  it("lets the accent follow a button colour set alone", () => {
    const tokens = brandTokens({ action: NAVY }, PAGE_COLORS.light);
    const roles = deriveBrandRoles({ action: NAVY }, PAGE_COLORS.light);
    expect(token(tokens, "--link")).toBe(roles.accentInk);
    expect(token(tokens, "--selected")).toBe(roles.accentFill);
    expect(token(tokens, "--ring")).toBe(roles.accentInk);
  });

  it("paints the band with the header colour, and leaves the band to the page when none is set", () => {
    expect(brandTokens({ header: NAVY }, PAGE_COLORS.light)["--app-header"]).toBe(NAVY);
    expect(brandTokens({ header: NAVY }, PAGE_COLORS.light)["--app-header-foreground"]).toBe(
      "#ffffff",
    );
    // No header colour writes no band token, so `globals.css` falls back to the page.
    for (const page of [PAGE_COLORS.light, PAGE_COLORS.dark]) {
      const tokens = brandTokens({ action: NAVY }, page);
      expect(tokens).not.toHaveProperty("--app-header");
      expect(tokens).not.toHaveProperty("--app-header-foreground");
    }
  });

  it("keeps the template's own --primary for a button colour a branded team did not set", () => {
    const tokens = brandTokens({ header: NAVY }, PAGE_COLORS.light);
    expect(tokens).not.toHaveProperty("--primary");
    expect(tokens).not.toHaveProperty("--primary-foreground");
    // With no button colour and no accent, nothing follows either: the link
    // ink, the selected fill and the focus ring stay the template's too.
    expect(tokens).not.toHaveProperty("--link");
    expect(tokens).not.toHaveProperty("--selected");
    expect(tokens).not.toHaveProperty("--ring");
  });

  it("writes no token at all for a theme whose team set no colour", () => {
    expect(brandTokens({}, PAGE_COLORS.light)).toEqual({});
    expect(brandTokens({ action: null, accent: null, header: null }, PAGE_COLORS.dark)).toEqual({});
  });

  it("is the kernel's derivation, role for role, on each theme's page", () => {
    const seeds = { action: NAVY, accent: AMBER, header: NAVY };
    for (const page of [PAGE_COLORS.light, PAGE_COLORS.dark]) {
      const roles = deriveBrandRoles(seeds, page);
      expect(brandTokens(seeds, page)).toEqual({
        "--primary": roles.action,
        "--primary-foreground": roles.onAction,
        "--link": roles.accentInk,
        "--selected": roles.accentFill,
        "--ring": roles.accentInk,
        "--app-header": roles.header,
        "--app-header-foreground": roles.onHeader,
      });
    }
  });

  it("never touches the contract's --accent, which is shadcn's neutral hover fill", () => {
    expect(Object.keys(brandTokens({ accent: AMBER }, PAGE_COLORS.light))).not.toContain(
      "--accent",
    );
  });

  it("keeps every text token readable on its background, across a sweep of seeds, in both themes", () => {
    const sweep: string[] = [];
    for (let r = 0; r < 256; r += 51)
      for (let g = 0; g < 256; g += 51)
        for (let b = 0; b < 256; b += 51)
          sweep.push(`#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`);
    for (const page of [PAGE_COLORS.light, PAGE_COLORS.dark]) {
      for (const seed of sweep) {
        const tokens = brandTokens({ action: seed, accent: seed, header: seed }, page);
        expect(
          contrast(token(tokens, "--primary-foreground"), token(tokens, "--primary")),
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrast(token(tokens, "--app-header-foreground"), token(tokens, "--app-header")),
        ).toBeGreaterThanOrEqual(4.5);
        expect(contrast(token(tokens, "--link"), page)).toBeGreaterThanOrEqual(4.5);
        expect(
          contrast(token(tokens, "--link"), token(tokens, "--selected")),
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe("brandStyleSheet", () => {
  it("writes the light set under :root and the dark set under .dark, each on its own page", () => {
    const sheet = brandStyleSheet({
      light: { action: NAVY, accent: AMBER, header: NAVY },
      dark: { action: AMBER, accent: AMBER, header: NAVY },
    });
    expect(rule(sheet, ":root")).toEqual(
      brandTokens({ action: NAVY, accent: AMBER, header: NAVY }, PAGE_COLORS.light),
    );
    expect(rule(sheet, ".dark")).toEqual(
      brandTokens({ action: AMBER, accent: AMBER, header: NAVY }, PAGE_COLORS.dark),
    );
  });

  it("writes no rule for a theme that sets no token, and no sheet for a team that set no colour", () => {
    const sheet = brandStyleSheet({ light: { header: NAVY }, dark: {} });
    expect(sheet).toBe(`:root{--app-header:${NAVY};--app-header-foreground:#ffffff;}`);
    expect(brandStyleSheet({ light: {}, dark: {} })).toBe("");
  });

  it("holds nothing but token names and hex colours, so it is safe as a <style>'s text", () => {
    const sheet = brandStyleSheet({ light: { action: NAVY }, dark: {} });
    expect(sheet).toMatch(/^(?:(?::root|\.dark)\{(?:--[a-z-]+:#[0-9a-f]{6};)+\}\n?)+$/);
  });

  it("refuses a seed that is not a colour rather than writing it", () => {
    expect(() =>
      brandStyleSheet({ light: { action: "#fff;}body{display:none" }, dark: {} }),
    ).toThrow();
  });
});

describe("PAGE_COLORS", () => {
  it("are the page colours globals.css paints, light under :root and dark under .dark", () => {
    const css = fs.readFileSync(path.resolve(process.cwd(), "src/app/globals.css"), "utf8");
    const page = (selector: string) =>
      css.match(new RegExp(`^${selector}\\s*\\{[^}]*--page:\\s*(#[0-9a-f]{6});`, "m"))?.[1];
    expect(page(":root")).toBe(PAGE_COLORS.light);
    expect(page("\\.dark")).toBe(PAGE_COLORS.dark);
  });
});
