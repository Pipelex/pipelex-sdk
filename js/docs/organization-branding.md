# An organization's branding

An organization may carry a brand: up to two logos, a square one and a wide one, and two colour sets of three colours, the light set and an optional dark one. The webapp shows it on the organization's menu and on the apps of its methods, and an app scaffolded from the method-app template reads it with its API key to wear the same brand. A personal workspace never has one. The client reaches it on two routes of the hosted API, and the types are in `src/product-models.ts`.

## The methods

| Method | Route | Who may call it | Answer |
|---|---|---|---|
| `getBranding()` | `GET /v1/branding` | Every member of the active organization, `runner` included, by web session or API key | The active organization's `OrganizationBranding`. |
| `updateOrganizationBranding(orgId, input)` | `PATCH /v1/organizations/{org_id}/branding` | An admin of the active organization, by web session | The `OrganizationBranding` as the write left it. |

Both answer the same shape, so a client holds one type whichever it called. `getBranding` takes no organization id: it reads the caller's active organization.

## The branding

| Field | Type | Meaning |
|---|---|---|
| `org_id` | `string` | The organization the branding belongs to. |
| `org_name` | `string` | Its display name, the wordmark a client shows when it has no logo; an API key has no other route to read it. |
| `colors` | `BrandingColors` | The light colour set. |
| `dark_colors` | `BrandingColors` | The dark colour set, used in dark mode only. |
| `square_logo` | `LogoDescriptor \| null` | The square logo, for the organization menu and small headers. |
| `wide_logo` | `LogoDescriptor \| null` | The wide logo, for an app's header. |

A `BrandingColors` always carries its three keys, each `#rrggbb` in lower case or `null` when not set: `action` is the button colour, `accent` the accent colour and `header` the header band's colour. A dark colour that is `null` falls back to the light colour of the same role, and a light one that is `null` to Pipelex's own palette for that theme. The `@pipelex/mthds-form/brand` entry turns a colour set into the roles a page paints with (`resolveDarkSeeds`, then `deriveBrandRoles` once per theme).

A `LogoDescriptor` is what the platform recorded when it accepted the logo:

| Field | Meaning |
|---|---|
| `uri` | The platform's own copy of the logo, `pipelex-storage://<org_id>/branding/<uuid>.<ext>`, never the upload URI the write sent: the platform copies every logo it accepts. Sending it back unchanged in its slot keeps the logo ([below](#writing-it)). `resolveStorageUrl` turns it into a short-lived link to its bytes; the webapp serves it through its asset proxy instead. |
| `sha256` | The SHA-256 of the logo's bytes, 64 lower-case hexadecimal digits, which serves as a cache key for them. |
| `content_type` | The type the platform read from the file's own bytes: `image/png`, `image/jpeg`, `image/webp` or `image/svg+xml`. |
| `width`, `height` | The size in pixels for a raster, oriented as a browser draws it; for an SVG, the width and height of its `viewBox`, else of its `width` and `height` in pixels, which may be fractional. Their ratio sizes the logo's box before the image loads. |

## Writing it

Every key of an `OrganizationBrandingUpdate` is optional: a value sets it, `null` clears it, and a key left out keeps its value, so `{}` writes nothing and answers the branding as it stands. A key holding `undefined` is a key left out, since it does not survive JSON.

```ts
// Set the button and accent colours, keep the header colour, clear the whole dark set,
// attach a square logo and remove the wide one.
const branding = await client.updateOrganizationBranding(orgId, {
  colors: { action: "#14213d", accent: "#fca311" },
  dark_colors: null,
  square_logo: "pipelex-storage://<org_id>/assets/<file>.png",
  wide_logo: null,
});
```

- **Colours** (`BrandingColorsUpdate`): each of `action`, `accent` and `header` takes `#rrggbb` in either case, stored in lower case. `colors: null` or `dark_colors: null` clears all three colours of that set.
- **Logos**: `square_logo` and `wide_logo` take one of three values. The `pipelex-storage://` URI of a file the organization uploaded on its own through `requestUploadGrant` or `upload` sets a new logo: the platform reads and measures it, then keeps its own copy under `branding/`, and the answer's `uri` names that copy, not the upload. The `uri` the branding answers for that slot, sent back unchanged, keeps the logo without reading it again. `null` removes the logo. Any other URI that is not a standalone upload, such as a run's or a method's file, or a `branding/` copy the branding does not answer, is refused as `logo_not_an_upload`. The logo a write replaces or clears is erased once the write has landed.
- **The rules a logo meets**: at most 1 MiB; a PNG, JPEG, WebP or SVG image by its bytes, whatever type the upload declared; a square logo's longer side at most 10% longer than its shorter, and a raster one at least 128 px on each side; a wide logo at least one and a half times as wide as it is tall, and a raster one at least 64 px tall. An SVG is measured from its root element, must declare no XML entities or external references, and must carry no active content: no script, no event handler, no `foreignObject`, and no `href` but a `#` fragment or a raster `data:image/` URI.

The write sends no `Idempotency-Key`, as `renameOrganization` sends none. A later write that should keep a logo leaves its key out, or sends back the `uri` the branding answered.

## When a write is refused

A refused write changes nothing, whichever part of it was refused, and throws an `ApiResponseError` whose `code` is the platform's:

| Status | `code` | When |
|---|---|---|
| `403` | `forbidden` | `orgId` is not the caller's active organization. |
| `403` | `role_not_permitted` | The caller is not the organization's admin. |
| `404` | `not_found` | The organization does not exist. |
| `409` | `conflict` | The organization is a personal workspace, which has no branding. |
| `422` | `validation_failed` | A colour is not `#rrggbb`, the body holds a key the route does not take, or a logo was refused. |
| `400` | `invalid_storage_uri` | A logo's URI is not a storage URI. |
| `403` | `forbidden` | A logo's URI is a file of another organization. |

**A refusal about a logo or a colour names it in `errors`**, the platform's field-level list, so the settings screen shows each sentence under the control it concerns rather than in a toast. Each entry's `field` is the slot, `square_logo` or `wide_logo`, or the colour's dotted key, such as `colors.action` or `dark_colors.header`; its `detail` is the sentence to show. A logo the platform read and refused carries a `LogoRefusalCode`, one entry per broken rule, both slots answered in one refusal:

| `code` | Example `detail` |
|---|---|
| `logo_not_an_upload` | The square logo must be a file uploaded for it (pipelex-storage://<organization>/assets/<file>), not a file that belongs to a run or a method. |
| `logo_not_found` | The square logo file was not found in the organization's uploads; upload it again. |
| `logo_too_large` | The wide logo file is 2,048 KiB; a logo file can be at most 1 MiB (1,024 KiB). |
| `logo_type_not_accepted` | The square logo file is a GIF image; a logo must be a PNG, JPEG, WebP or SVG image. |
| `logo_unreadable` | The wide logo is an SVG that cannot be read: it is not well-formed XML. |
| `logo_active_content` | (An SVG that carries a script, an event handler, a `foreignObject`, or an `href` that is neither a `#` fragment nor a raster `data:image/` URI.) |
| `logo_not_square` | The square logo is 640 × 512 px, 1.25 times as wide as it is tall; a square logo's longer side can be at most 10% longer than its shorter side. |
| `logo_too_small` | The square logo is 100 × 100 px; a square logo must be at least 128 px on each side. |
| `logo_not_wide` | The wide logo is 600 × 500 px, 1.2 times as wide as it is tall; a wide logo must be at least 1.5 times as wide as it is tall. |
| `logo_too_short` | The wide logo is 240 × 48 px; a wide logo must be at least 64 px tall. |

The two refusals of a logo URI that come before any file is read, `invalid_storage_uri` and another organization's `forbidden`, name the slot the same way, with the platform's code in the entry. A colour's entry carries pydantic's code, such as `string_pattern_mismatch`. Reading one slot's sentences is the same filter in every case:

```ts
try {
  await client.updateOrganizationBranding(orgId, { square_logo: uri });
} catch (err) {
  if (!(err instanceof ApiResponseError)) throw err;
  const underSquare = (err.errors ?? [])
    .filter((entry) => entry.field === "square_logo")
    .map((entry) => entry.detail);
  // Show `underSquare` under the square logo's slot; an error naming no field goes in a toast.
}
```

`getBranding` answers `400` when the caller has no active organization and `404` when its organization's row is missing. Either method throws the `ApiResponseError` of an answer it cannot read for a `2xx` that is not a JSON object, an empty one included.
