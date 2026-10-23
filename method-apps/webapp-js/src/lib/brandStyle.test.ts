import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { contrastRatio, deriveBrandRoles, PIPELEX_GREEN } from "@pipelex/mthds-form/brand";
import { brandStyleSheet, brandTokens, PAGE_COLORS } from "@/lib/brandStyle";

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
    expect(tokens["--primary"]).toBe(NAVY);
    expect(tokens["--primary-foreground"]).toBe("#ffffff");
    expect(brandTokens({ action: AMBER }, PAGE_COLORS.light)["--primary-foreground"]).toBe(
      "#000000",
    );
  });

  it("puts the accent's ink on --brand, never the raw accent, so brand text always reads", () => {
    const tokens = brandTokens({ action: NAVY, accent: AMBER }, PAGE_COLORS.light);
    // Amber on the light page is a fill, not a text colour: the ink is a deeper amber.
    expect(contrast(AMBER, PAGE_COLORS.light)).toBeLessThan(4.5);
    expect(tokens["--brand"]).not.toBe(AMBER);
    expect(contrast(tokens["--brand"], PAGE_COLORS.light)).toBeGreaterThanOrEqual(4.5);
    // The ink on the pale fill, the kernel's selected pill and this app's run status.
    expect(tokens["--brand-muted-foreground"]).toBe(tokens["--brand"]);
    expect(contrast(tokens["--brand"], tokens["--brand-muted"])).toBeGreaterThanOrEqual(4.5);
  });

  it("paints the band with the header colour, and with the page when none is set", () => {
    expect(brandTokens({ header: NAVY }, PAGE_COLORS.light)["--app-header"]).toBe(NAVY);
    expect(brandTokens({ header: NAVY }, PAGE_COLORS.light)["--app-header-foreground"]).toBe(
      "#ffffff",
    );
    expect(brandTokens({}, PAGE_COLORS.light)["--app-header"]).toBe(PAGE_COLORS.light);
    expect(brandTokens({}, PAGE_COLORS.dark)["--app-header"]).toBe(PAGE_COLORS.dark);
  });

  it("falls back to Pipelex green for a button colour a branded team did not set", () => {
    expect(brandTokens({ header: NAVY }, PAGE_COLORS.light)["--primary"]).toBe(PIPELEX_GREEN);
  });

  it("is the kernel's derivation, role for role, on each theme's page", () => {
    const seeds = { action: NAVY, accent: AMBER, header: NAVY };
    for (const page of [PAGE_COLORS.light, PAGE_COLORS.dark]) {
      const roles = deriveBrandRoles(seeds, page);
      expect(brandTokens(seeds, page)).toEqual({
        "--primary": roles.action,
        "--primary-foreground": roles.onAction,
        "--brand": roles.accentInk,
        "--brand-muted": roles.accentFill,
        "--brand-muted-foreground": roles.accentInk,
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
          contrast(tokens["--primary-foreground"], tokens["--primary"]),
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrast(tokens["--app-header-foreground"], tokens["--app-header"]),
        ).toBeGreaterThanOrEqual(4.5);
        expect(contrast(tokens["--brand"], page)).toBeGreaterThanOrEqual(4.5);
        expect(
          contrast(tokens["--brand-muted-foreground"], tokens["--brand-muted"]),
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
