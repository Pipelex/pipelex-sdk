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
| `uri` | The platform's own copy of the logo, `pipelex-storage://<org_id>/branding/<uuid>.<ext>`, never the upload URI the write sent: the platform copies every logo it accepts, under a fresh uuid each time, so the same bytes attached again get a new URI. Sending it back unchanged in its slot keeps the logo ([below](#writing-it)). `resolveStorageUrl` turns it into a short-lived link to its bytes; the webapp serves it through its asset proxy instead. |
| `sha256` | The SHA-256 of the logo's bytes, 64 lower-case hexadecimal digits, which serves as a cache key for them. |
| `content_type` | The type the platform read from the file's own bytes: `image/png`, `image/jpeg`, `image/webp` or `image/svg+xml`. |
| `width`, `height` | The size in pixels for a raster, oriented as a browser draws it; for an SVG, its `width` and `height` in pixels when both are in absolute units, which is the size a browser draws it at, else the width and height of its `viewBox`; an SVG's may be fractional. Their ratio sizes the logo's box before the image loads. |

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
- **Logos**: `square_logo` and `wide_logo` take one of three values. The `pipelex-storage://` URI of a file the organization uploaded on its own through `requestUploadGrant` or `upload` sets a new logo: the platform reads and measures it, then writes its own copy under `branding/`, and the answer's `uri` names that copy, never the upload, which the platform leaves as it is. The `uri` the branding answers for that slot, sent back unchanged, leaves the slot out of the write: nothing is read, and the slot keeps whatever logo the branding names when the write lands, so a save that resends the logo it read never puts back one a concurrent save replaced. `null` removes the logo. Any other URI is refused as `logo_not_an_upload`: a run's or a method's file, a `branding/` copy the slot no longer holds, and the other slot's logo too, so a logo cannot move between slots by its URI; upload it again for the other slot instead. Once the write has landed, the platform erases the `branding/` copy it replaced or cleared.
- **The rules a logo meets**: at most 1 MiB; a PNG, JPEG, WebP or SVG image by its bytes, whatever type the upload declared, an SVG in UTF-8 or, behind its byte-order mark, UTF-16; a still image, so never an animated PNG (an APNG) or an animated WebP; a raster of at most 4096 × 4096 pixels that decodes whole; a square logo's longer side at most 10% longer than its shorter, and a raster one at least 128 px on each side; a wide logo at least one and a half times as wide as it is tall, and a raster one at least 64 px tall. An SVG is measured from its root element, by its `width` and `height` when both are in absolute units, else by its `viewBox`, and each side must lie between 0.001 and 1,000,000, in pixels for a `width` or `height` and in the SVG's own units for a `viewBox`. It must declare no XML entities or external references and carry no active content: no `script` or `foreignObject` element, no element in the XHTML namespace, no `on…` event handler attribute, no `set` or `animate` that rewrites a link, no `xml-stylesheet` processing instruction, and no link but a reference inside the file (`#…`) or an embedded PNG, JPEG, GIF or WebP image (`data:image/…`), whether an `href`, an `xlink:href`, or a CSS `url()` or `src()`. Wherever a browser reads CSS, which is a `<style>` element's text and any attribute in no namespace or the SVG one, such as `style`, `fill` or `filter`, it must hold no `@import`, no `image()` or `image-set()`, and no escape (a backslash, which can spell a link out of sight). A `<style>` element itself is allowed, so the class-based styles a design tool exports pass, and so does a reference inside the file such as `fill:url(#grad)`; an attribute in another namespace, such as Inkscape's `inkscape:export-filename`, and a `data-*` one, such as the layer names Illustrator writes in `data-name`, are never read as CSS.

The write sends no `Idempotency-Key`, as `renameOrganization` sends none. A later write that should keep a logo leaves its key out, or sends back the `uri` the branding answered.

## When a write is refused

A refused write changes nothing, whichever part of it was refused, and throws an `ApiResponseError` whose `code` is the platform's; only a `503` leaves it unknown whether the write landed:

| Status | `code` | When |
|---|---|---|
| `403` | `forbidden` | `orgId` is not the caller's active organization. |
| `403` | `role_not_permitted` | The caller is not the organization's admin. |
| `404` | `not_found` | The organization does not exist. |
| `409` | `conflict` | The organization is a personal workspace, which has no branding. |
| `422` | `validation_failed` | A colour is not `#rrggbb`, the body holds a key the route does not take, or a logo was refused. |
| `400` | `invalid_storage_uri` | A logo's URI is not a storage URI. |
| `403` | `forbidden` | A logo's URI is a file of another organization. |
| `500` | `storage_backend_failed` | The platform's storage failed while reading or copying a logo. Its verdict is `runtime` and retryable, and nothing was written. |
| `503` | `service_unavailable` | The platform's database failed or could not be reached, so the write may have landed or not. Its verdict is `runtime` and retryable: the same `input` sent again is safe, and `getBranding` reads what the branding holds. |

**A refusal about a logo or a colour names it in `errors`**, the platform's field-level list, so the settings screen shows each sentence under the control it concerns rather than in a toast. Each entry's `field` is the slot, `square_logo` or `wide_logo`, or the colour's dotted key, such as `colors.action` or `dark_colors.header`; its `detail` is the sentence to show. A logo the platform read and refused carries a `LogoRefusalCode`, one entry per broken rule, both slots answered in one refusal:

| `code` | Example `detail` |
|---|---|
| `logo_not_an_upload` | The square logo must be a newly uploaded file (pipelex-storage://<organization>/assets/<file>) or the URI the square logo already has. |
| `logo_not_found` | The square logo file was not found in the organization's uploads; upload it again. |
| `logo_too_large` | The wide logo file is 2,048 KiB; a logo file can be at most 1 MiB (1,024 KiB). |
| `logo_type_not_accepted` | The square logo file is a GIF image; a logo must be a PNG, JPEG, WebP or SVG image. (An animation reads "The square logo is an animated WebP; a logo must be a still image.", or "an animated PNG" for an APNG.) |
| `logo_unreadable` | The wide logo is an SVG that cannot be read: it is not well-formed XML. (An SVG side out of range reads "… its width or height lies outside the 0.001 to 1,000,000 px a logo's side may measure.", or "… its viewBox's width or height lies outside the 0.001 to 1,000,000 units a logo's side may measure." A raster reads "The square logo looks like a JPEG image but cannot be read: the file is damaged or incomplete.", its one frame being decoded whole so a file cut short is caught whatever its format, or "… at 5,000 × 5,000 px it has more than the 16,777,216 pixels (4096 × 4096) a logo may have.") |
| `logo_active_content` | The square logo is an SVG that carries active content, which a logo may not: a \<script\> element. (Or: a \<foreignObject\> element; an element in the XHTML namespace; an event handler attribute (onload); a \<set\> element that rewrites a link; a link to something outside the file, where only a reference inside it or an embedded PNG, JPEG, GIF or WebP image is allowed; an xml-stylesheet processing instruction, which loads a style sheet; a CSS @import, which loads a style sheet; a CSS url() that links to something outside the file, where only a reference inside it or an embedded PNG, JPEG, GIF or WebP image is allowed, which reads "a CSS src()" for `src()`; a CSS image-set() function, which can load an image from outside the file, which reads "a CSS image() function" for `image()`; a CSS escape (a backslash), which can disguise a link.) |
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
