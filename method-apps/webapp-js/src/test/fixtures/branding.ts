import { createHash } from "node:crypto";
import type { LogoDescriptor, OrganizationBranding } from "@pipelex/sdk";

/**
 * Organization branding as `GET /v1/branding` answers it, in the shape the
 * SDK's `OrganizationBranding` types, for the tests of the branding read, the
 * logo route and the page. Test data only, never imported by app code.
 */

/** A tiny PNG's bytes: what the logo route serves, and what its digest hashes. */
export const WIDE_LOGO_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
export const SQUARE_LOGO_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 2,
]);

export function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export const WIDE_LOGO: LogoDescriptor = {
  uri: "pipelex-storage://org_acme/branding/wide.png",
  sha256: sha256Of(WIDE_LOGO_BYTES),
  content_type: "image/png",
  width: 640,
  height: 160,
};

export const SQUARE_LOGO: LogoDescriptor = {
  uri: "pipelex-storage://org_acme/branding/square.png",
  sha256: sha256Of(SQUARE_LOGO_BYTES),
  content_type: "image/png",
  width: 256,
  height: 256,
};

/** A team that set nothing: every colour and logo `null`. */
export const UNBRANDED: OrganizationBranding = {
  org_id: "org_acme",
  org_name: "Acme Corporation",
  colors: { action: null, accent: null, header: null },
  dark_colors: { action: null, accent: null, header: null },
  square_logo: null,
  wide_logo: null,
};

/** A team that set both logos and a full light set (navy button and band, amber accent). */
export const BRANDED: OrganizationBranding = {
  ...UNBRANDED,
  colors: { action: "#14213d", accent: "#fca311", header: "#14213d" },
  square_logo: SQUARE_LOGO,
  wide_logo: WIDE_LOGO,
};

export function branding(overrides: Partial<OrganizationBranding> = {}): OrganizationBranding {
  return { ...UNBRANDED, ...overrides };
}
