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
 * Only the colours the team set produce tokens. A seed left unset produces no
 * role, so its tokens are not written and the template's own stay: a team
 * that set no button colour keeps the template's `--primary`, and one that
 * set no colour at all in a theme gets no rule for that theme.
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

/** The tokens one theme sets, each a `#rrggbb` colour, and only those its seeds produce. */
export type BrandTokens = Readonly<Partial<Record<BrandTokenName, string>>>;

export type BrandTokenName =
  | "--primary"
  | "--primary-foreground"
  | "--link"
  | "--selected"
  | "--ring"
  | "--app-header"
  | "--app-header-foreground";

const HEX = /^#[0-9a-f]{6}$/;

/**
 * The tokens one theme sets, from that theme's seeds and its page colour.
 *
 * - **The button colour is a fill, never text**: `--primary` is the Run button,
 *   with `--primary-foreground`, black or white, on it. Written only when the
 *   team set a button colour.
 * - **Every accent-coloured text is the accent's ink**: `--link` carries
 *   `accentInk`, which reads at 4.5:1 on the page and on the pale accent fill
 *   `--selected`, so the active tab's underline, the run status and the
 *   kernel's selected pills read whatever accent was picked. `--ring`, the
 *   focus the kernel's controls draw, carries the same ink, so focus wears the
 *   brand and reads against the page. Written when the team set an accent, or
 *   a button colour the accent follows; otherwise `--link` and `--selected`
 *   fall back in `globals.css` and the kernel's `theme.css` keeps its `--ring`.
 * - **The header band** is `--app-header`, with `--app-header-foreground` on
 *   it. Written only when the team set a header colour; otherwise the band
 *   falls back to the page in `globals.css`, so no band shows.
 *
 * The organization's accent never maps onto the contract's `--accent`, which
 * is shadcn's neutral hover fill, not a brand colour: painting it would tint
 * every hovered row.
 */
export function brandTokens(seeds: BrandSeeds, page: string): BrandTokens {
  const roles = deriveBrandRoles(seeds, page);
  const tokens: Partial<Record<BrandTokenName, string>> = {};
  if (roles.action !== undefined) {
    tokens["--primary"] = roles.action;
    tokens["--primary-foreground"] = roles.onAction;
  }
  if (roles.accentInk !== undefined) {
    tokens["--link"] = roles.accentInk;
    tokens["--selected"] = roles.accentFill;
    tokens["--ring"] = roles.accentInk;
  }
  if (roles.header !== undefined) {
    tokens["--app-header"] = roles.header;
    tokens["--app-header-foreground"] = roles.onHeader;
  }
  return tokens;
}

/**
 * The stylesheet of a branded app: the light tokens under `:root`, the dark
 * ones under `.dark`, and no rule for a theme that sets none, so a team that
 * set logos and no colour gets an empty sheet.
 */
export function brandStyleSheet(branding: Pick<AppBranding, "light" | "dark">): string {
  return [
    rule(":root", brandTokens(branding.light, PAGE_COLORS.light)),
    rule(".dark", brandTokens(branding.dark, PAGE_COLORS.dark)),
  ]
    .filter((text) => text !== "")
    .join("\n");
}

function rule(selector: string, tokens: BrandTokens): string {
  const body = Object.entries(tokens)
    .map(([name, value]) => {
      if (value === undefined || !HEX.test(value)) {
        throw new Error(`${name} must be a #rrggbb colour, not ${value}.`);
      }
      return `${name}:${value};`;
    })
    .join("");
  return body === "" ? "" : `${selector}{${body}}`;
}
