import { resolveDarkSeeds, type BrandSeeds } from "@pipelex/mthds-form/brand";

/**
 * The organization's branding as this app wears it — the pure half.
 *
 * An organization's admin may give it up to two logos (a square one and a wide
 * one) and two sets of three colours (a light set and an optional dark one),
 * and the app reads them with its own API key (`readOrganizationBranding` in
 * `brandingRead.ts`). This module turns that answer into what the page paints:
 * whether the app is branded at all, the seeds of each theme, and the logos in
 * the order the header tries them. It takes the answer as untrusted JSON and
 * keeps only what it can use — a colour that is not `#rrggbb` is unset, a logo
 * whose description is incomplete is left out — so nothing the API sends can
 * break the page: branding never stops the app.
 *
 * Pure and client-safe at runtime, though only the server calls it: the
 * client half, `BrandBand`, imports its types alone.
 */

/** A logo as the header draws it: the path this app serves it at, and its shape. */
export interface BandLogo {
  /** `/api/branding/logo/<sha256>`, served by this app's own origin. */
  src: string;
  /**
   * The logo's width and height, in units whose only meaning is their ratio:
   * the browser sizes the logo's box from them before the image arrives, so
   * the header does not shift when it does.
   */
  width: number;
  height: number;
}

/** The branding of a branded app; an unbranded app has none (`brandingFromApi` answers `null`). */
export interface AppBranding {
  /** The organization's display name: the logo's alt text, and the wordmark when no logo loads. */
  orgName: string;
  /** The light set, each colour `#rrggbb` in lower case or `null` when not set. */
  light: BrandSeeds;
  /** The dark set as the dark theme uses it: each dark colour, else the light one of its role. */
  dark: BrandSeeds;
  /** The logos the header tries, in order: the wide one, then the square one. */
  logos: BandLogo[];
  /**
   * Whether a logo sits on a white tile in the dark theme, which is when the
   * dark theme has no header colour: the band is then the dark page, and most
   * logos are drawn for white. With a header colour the logo sits on it, in
   * both themes, undecorated.
   */
  tileInDark: boolean;
}

/** A logo of the organization, as the logo route serves it. */
export interface LogoRecord {
  /** The platform's own copy of the logo, a `pipelex-storage://` reference. */
  uri: string;
  /** The SHA-256 of its bytes, 64 lower-case hexadecimal digits: the logo's cache key. */
  sha256: string;
  /** The type the platform read from the file's own bytes. */
  contentType: LogoContentType;
  width: number;
  height: number;
}

/** The four types the platform accepts a logo in, read from the file's own bytes. */
export const LOGO_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/svg+xml",
] as const;
export type LogoContentType = (typeof LOGO_CONTENT_TYPES)[number];

/** Where this app serves a logo: its digest names it, so the URL changes when the logo does. */
export const LOGO_ROUTE = "/api/branding/logo";

const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const STORAGE_PREFIX = "pipelex-storage://";
const COLOR_ROLES = ["action", "accent", "header"] as const;

/**
 * The height every logo's shape is expressed at. A box needs only the ratio,
 * and an SVG's own size may be fractional or tiny (a `viewBox` of `0 0 1 0.2`),
 * which `width` and `height` attributes would round away.
 */
const SHAPE_HEIGHT = 100;

/** Whether `value` is a logo's digest as the platform writes one. */
export function isLogoDigest(value: unknown): value is string {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}

/** The path this app serves the logo of a digest at. */
export function logoPath(sha256: string): string {
  return `${LOGO_ROUTE}/${sha256}`;
}

/**
 * The branding this app wears, from what `getBranding` answered, or `null`
 * when the app is unbranded: when the answer is missing (the read failed or
 * timed out) or sets no logo and no colour. The organization's name alone does
 * not brand an app, since every organization has one.
 */
export function brandingFromApi(answer: unknown): AppBranding | null {
  if (!isRecord(answer)) return null;
  const light = readColors(answer.colors);
  const darkSet = readColors(answer.dark_colors);
  const logos = organizationLogos(answer);
  const anyColor = COLOR_ROLES.some((role) => light[role] !== null || darkSet[role] !== null);
  if (!anyColor && logos.length === 0) return null;

  const dark = resolveDarkSeeds(light, darkSet);
  return {
    orgName: typeof answer.org_name === "string" ? answer.org_name.trim() : "",
    light,
    dark,
    logos: logos.map(bandLogo),
    tileInDark: dark.header == null,
  };
}

/**
 * The organization's logos whose description is complete, in the order the
 * header tries them: the wide one first, since it is the one drawn for a
 * header, then the square one. What the logo route serves, and all it serves.
 */
export function organizationLogos(answer: unknown): LogoRecord[] {
  if (!isRecord(answer)) return [];
  return [readLogo(answer.wide_logo), readLogo(answer.square_logo)].filter(
    (logo): logo is LogoRecord => logo !== null,
  );
}

function bandLogo(logo: LogoRecord): BandLogo {
  return {
    src: logoPath(logo.sha256),
    width: Math.max(1, Math.round((logo.width / logo.height) * SHAPE_HEIGHT)),
    height: SHAPE_HEIGHT,
  };
}

function readColors(value: unknown): Required<BrandSeeds> {
  const set = isRecord(value) ? value : {};
  return {
    action: readColor(set.action),
    accent: readColor(set.accent),
    header: readColor(set.header),
  };
}

function readColor(value: unknown): string | null {
  return typeof value === "string" && COLOR_PATTERN.test(value) ? value.toLowerCase() : null;
}

function readLogo(value: unknown): LogoRecord | null {
  if (!isRecord(value)) return null;
  const { uri, sha256, content_type: contentType, width, height } = value;
  if (typeof uri !== "string" || !uri.startsWith(STORAGE_PREFIX)) return null;
  if (!isLogoDigest(sha256)) return null;
  if (!isLogoContentType(contentType)) return null;
  if (!isPositive(width) || !isPositive(height)) return null;
  return { uri, sha256, contentType, width, height };
}

function isLogoContentType(value: unknown): value is LogoContentType {
  return (LOGO_CONTENT_TYPES as readonly unknown[]).includes(value);
}

function isPositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
