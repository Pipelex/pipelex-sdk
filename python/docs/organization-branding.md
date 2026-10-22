# An organization's branding

An organization may carry a brand: up to two logos, a square one and a wide one, and two colour sets of three colours, the light set and an optional dark one. The webapp shows it on the organization's menu and on the apps of its methods, and an app scaffolded from a method-app template reads it with its API key to wear the same brand. A personal workspace never has one. The client reaches it on two routes of the hosted API, and the models are in `pipelex_sdk.product_models`. It is the twin of `@pipelex/sdk`'s `getBranding` and `updateOrganizationBranding`.

## The methods

| Method | Route | Who may call it | Answer |
|---|---|---|---|
| `get_branding()` | `GET /v1/branding` | Every member of the active organization, `runner` included, by web session or API key | The active organization's `OrganizationBranding`. |
| `update_organization_branding(org_id, update)` | `PATCH /v1/organizations/{org_id}/branding` | An admin of the active organization, by web session | The `OrganizationBranding` as the write left it. |

Both answer the same model, so a client holds one type whichever it called. `get_branding` takes no organization id: it reads the caller's active organization.

## The branding

| Field | Type | Meaning |
|---|---|---|
| `org_id` | `str` | The organization the branding belongs to. |
| `org_name` | `str` | Its display name, the wordmark a client shows when it has no logo; an API key has no other route to read it. |
| `colors` | `BrandingColors` | The light colour set. |
| `dark_colors` | `BrandingColors` | The dark colour set, used in dark mode only. |
| `square_logo` | `LogoDescriptor \| None` | The square logo, for the organization menu and small headers. |
| `wide_logo` | `LogoDescriptor \| None` | The wide logo, for an app's header. |

A `BrandingColors` always carries its three fields, each `#rrggbb` in lower case or `None` when not set: `action` is the button colour, `accent` the accent colour and `header` the header band's colour. A dark colour that is `None` falls back to the light colour of the same role, and a light one that is `None` to Pipelex's own palette for that theme.

A `LogoDescriptor` is what the platform recorded when it accepted the logo:

| Field | Meaning |
|---|---|
| `uri` | The logo's `pipelex-storage://` URI. `resolve_storage_url` turns it into a short-lived link to its bytes. |
| `sha256` | The SHA-256 of the logo's bytes, 64 lower-case hexadecimal digits, which serves as a cache key for them. |
| `content_type` | The type the platform read from the file's own bytes: `image/png`, `image/jpeg`, `image/webp` or `image/svg+xml`. |
| `width`, `height` | `float`s: the size in pixels for a raster, oriented as a browser draws it; for an SVG, the width and height of its `viewBox`, else of its `width` and `height` in pixels, which may be fractional. Their ratio sizes the logo's box before the image loads. |

The response models are extension-open (`extra="allow"`), as every product model is, so a field a later platform adds is kept rather than refused.

## Writing it

Only the fields an `OrganizationBrandingUpdate` sets are sent: a value sets it, an explicit `None` clears it, and a field left unset keeps its value, so `OrganizationBrandingUpdate()` writes nothing and answers the branding as it stands. The model is closed (`extra="forbid"`), and so is `BrandingColorsUpdate`, so a misspelt field is refused when the update is built.

```python
from pipelex_sdk.product_models import BrandingColorsUpdate, OrganizationBrandingUpdate

# Set the button and accent colours, keep the header colour, clear the whole dark set,
# attach a square logo and remove the wide one.
branding = await client.update_organization_branding(
    org_id,
    OrganizationBrandingUpdate(
        colors=BrandingColorsUpdate(action="#14213d", accent="#fca311"),
        dark_colors=None,
        square_logo="pipelex-storage://<org_id>/assets/<file>.png",
        wide_logo=None,
    ),
)
```

- **Colours** (`BrandingColorsUpdate`): each of `action`, `accent` and `header` takes `#rrggbb` in either case, stored in lower case. `colors=None` or `dark_colors=None` clears all three colours of that set. The client does not check a colour itself: the platform does, and names the field it refused.
- **Logos**: `square_logo` and `wide_logo` take the `pipelex-storage://` URI of a file the organization uploaded on its own (`upload`), never a run's or a method's file. The platform reads and measures the file before it records it. A URI equal to the one the slot already holds keeps its logo without reading it again. The object a write replaces or clears is erased once the write has landed.
- **The rules a logo meets**: at most 1 MiB; a PNG, JPEG, WebP or SVG image by its bytes, whatever type the upload declared; a square logo's longer side at most 10% longer than its shorter, and a raster one at least 128 px on each side; a wide logo at least one and a half times as wide as it is tall, and a raster one at least 64 px tall. An SVG is measured from its root element and must not declare entities or refer to external resources.

The write sends no `Idempotency-Key`, as `rename_organization` sends none: sending the same write again lands on the same branding, a logo already in its slot being kept as it is.

## When a write is refused

A refused write changes nothing, whichever part of it was refused, and raises an `ApiResponseError` whose `code` is the platform's:

| Status | `code` | When |
|---|---|---|
| `403` | `forbidden` | `org_id` is not the caller's active organization. |
| `403` | `role_not_permitted` | The caller is not the organization's admin. |
| `404` | `not_found` | The organization does not exist. |
| `409` | `conflict` | The organization is a personal workspace, which has no branding. |
| `422` | `validation_failed` | A colour is not `#rrggbb`, or a logo was refused. |
| `400` | `invalid_storage_uri` | A logo's URI is not a storage URI. |
| `403` | `forbidden` | A logo's URI is a file of another organization. |

**A refusal about a logo or a colour names it in `errors`**, the platform's field-level list of `FieldError`s, so a settings screen shows each sentence under the control it concerns. Each entry's `field` is the slot, `square_logo` or `wide_logo`, or the colour's dotted key, such as `colors.action` or `dark_colors.header`; its `detail` is the sentence to show. A logo the platform read and refused carries a `LogoRefusalCode` (`pipelex_sdk.errors`), one entry per broken rule, both slots answered in one refusal:

| `code` | `LogoRefusalCode` | Example `detail` |
|---|---|---|
| `logo_not_an_upload` | `NOT_AN_UPLOAD` | The square logo must be a file uploaded for it (pipelex-storage://<organization>/assets/<file>), not a file that belongs to a run or a method. |
| `logo_not_found` | `NOT_FOUND` | The square logo file was not found in the organization's uploads; upload it again. |
| `logo_too_large` | `TOO_LARGE` | The wide logo file is 2,048 KiB; a logo file can be at most 1 MiB (1,024 KiB). |
| `logo_type_not_accepted` | `TYPE_NOT_ACCEPTED` | The square logo file is a GIF image; a logo must be a PNG, JPEG, WebP or SVG image. |
| `logo_unreadable` | `UNREADABLE` | The wide logo is an SVG that cannot be read: it is not well-formed XML. |
| `logo_not_square` | `NOT_SQUARE` | The square logo is 640 × 512 px, 1.25 times as wide as it is tall; a square logo's longer side can be at most 10% longer than its shorter side. |
| `logo_too_small` | `TOO_SMALL` | The square logo is 100 × 100 px; a square logo must be at least 128 px on each side. |
| `logo_not_wide` | `NOT_WIDE` | The wide logo is 600 × 500 px, 1.2 times as wide as it is tall; a wide logo must be at least 1.5 times as wide as it is tall. |
| `logo_too_short` | `TOO_SHORT` | The wide logo is 240 × 48 px; a wide logo must be at least 64 px tall. |

The two refusals of a logo URI that come before any file is read, `invalid_storage_uri` and another organization's `forbidden`, name the slot the same way, with the platform's code in the entry. A colour's entry carries pydantic's code, such as `string_pattern_mismatch`. Reading one slot's sentences is the same filter in every case:

```python
try:
    await client.update_organization_branding(org_id, OrganizationBrandingUpdate(square_logo=uri))
except ApiResponseError as exc:
    under_square = [entry.detail for entry in exc.errors or [] if entry.field == "square_logo"]
```

`get_branding` raises `400` when the caller has no active organization and `404` when its organization's row is missing. Either method raises the `ApiResponseError` of an answer it cannot read for a `2xx` that is not the branding, an empty one included.
