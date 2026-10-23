import { deriveBrandRoles, type BrandSeeds } from "@pipelex/mthds-form/brand";
import type { AppBranding } from "@/lib/branding";

/**
 * The organization's colours as CSS custom properties — the stylesheet the
 * page renders on a branded app, one rule per theme.
 *
 * `deriveBrandRoles` (`@pipelex/mthds-form/brand`) turns a theme's three seeds
 * and the colour of that theme's page into the roles a page paints with, and
 * this module maps each role onto the token this app's controls read. The
 * fills are the admin's own colours, exactly; every colour used as text is
 * derived to read, black or white on a fill and the accent's ink on the page,
 * measured against the page of its own theme. So the light set is derived on
 * the light page and written under `:root`, and the dark set on the dark page
 * and written under `.dark`, the class convention the kernel's `theme.css`
 * and `globals.css` follow.
 *
 * The values are hex colours the derivation produced, never a string the API
 * sent, and `brandStyleSheet` refuses anything else before it writes a
 * declaration, which is what makes it safe to render the sheet as the text of
 * a `<style>` element.
 */

/**
 * The page colour of each theme: what `html` and `body` paint (`--page` in
 * `globals.css`, which a test holds to these values), and what every text
 * role is measured against. The dark one is the kernel's own dark background.
 */
export const PAGE_COLORS = { light: "#f8fafc", dark: "#09090b" } as const;

/** The tokens one theme sets, each a `#rrggbb` colour. */
export type BrandTokens = Readonly<Record<BrandTokenName, string>>;

export type BrandTokenName =
  | "--primary"
  | "--primary-foreground"
  | "--brand"
  | "--brand-muted"
  | "--brand-muted-foreground"
  | "--app-header"
  | "--app-header-foreground";

const HEX = /^#[0-9a-f]{6}$/;

/**
 * The tokens one theme sets, from that theme's seeds and its page colour.
 *
 * - **The button colour is a fill, never text**: `--primary` is the Run button,
 *   with `--primary-foreground`, black or white, on it.
 * - **Every brand-coloured text is the accent's ink**: `--brand` and
 *   `--brand-muted-foreground` carry `accentInk`, which reads at 4.5:1 on the
 *   page and on the pale accent fill `--brand-muted`, so a link, a selected
 *   pill's checkmark, the active tab's underline and the run status read
 *   whatever accent was picked. The kernel's controls read these three since
 *   `@pipelex/mthds-form` 0.21.0.
 * - **The header band** is `--app-header`, with `--app-header-foreground` on
 *   it; an unset header colour is the page, so no band shows.
 *
 * The organization's accent never maps onto the contract's `--accent`, which
 * is shadcn's neutral hover fill, not a brand colour: painting it would tint
 * every hovered row.
 */
export function brandTokens(seeds: BrandSeeds, page: string): BrandTokens {
  const roles = deriveBrandRoles(seeds, page);
  return {
    "--primary": roles.action,
    "--primary-foreground": roles.onAction,
    "--brand": roles.accentInk,
    "--brand-muted": roles.accentFill,
    "--brand-muted-foreground": roles.accentInk,
    "--app-header": roles.header,
    "--app-header-foreground": roles.onHeader,
  };
}

/** The stylesheet of a branded app: the light tokens under `:root`, the dark ones under `.dark`. */
export function brandStyleSheet(branding: Pick<AppBranding, "light" | "dark">): string {
  return [
    `:root{${declarations(brandTokens(branding.light, PAGE_COLORS.light))}}`,
    `.dark{${declarations(brandTokens(branding.dark, PAGE_COLORS.dark))}}`,
  ].join("\n");
}

function declarations(tokens: BrandTokens): string {
  return Object.entries(tokens)
    .map(([name, value]) => {
      if (!HEX.test(value)) throw new Error(`${name} must be a #rrggbb colour, not ${value}.`);
      return `${name}:${value};`;
    })
    .join("");
}
