# An organization's branding

An organization may carry a brand, its branding kit: a square logo and a wide one, each with an optional dark-mode variant, two colour sets of three colours, the light set and an optional dark one, a preset, a page shell, a typeface and a design system. The webapp shows it on the organization's menu and on the apps of its methods, and an app scaffolded from a method-app template reads it with its API key to wear the same brand. A personal workspace never has one. Beside the brand, the branding says whether the organization holds the white-label entitlement, which Pipelex staff grant. The client reaches it on two routes of the hosted API, and the models are in `pipelex_sdk.product_models`. It is the twin of `@pipelex/sdk`'s `getBranding` and `updateOrganizationBranding`.

## The methods

| Method | Route | Who may call it | Answer |
|---|---|---|---|
| `get_branding()` | `GET /v1/branding` | Every member of the active organization, `runner` included, by web session or API key | The active organization's `OrganizationBranding`. |
| `update_organization_branding(org_id, update)` | `PATCH /v1/organizations/{org_id}/branding` | A caller with the `admin` or the `member` role in the active organization, never a `runner`, by web session | The `OrganizationBranding` as the write left it. |

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
| `dark_square_logo` | `LogoDescriptor \| None` | The square logo for dark mode; `None` falls back to `square_logo`. |
| `dark_wide_logo` | `LogoDescriptor \| None` | The wide logo for dark mode; `None` falls back to `wide_logo`. |
| `preset` | `str \| None` | The id of the preset the team started its design system from, `None` when not set. |
| `shell` | `str \| None` | The id of the page shell the team's method apps wear, `None` when not set. |
| `typeface` | `str \| None` | The id of the typeface the team sets its apps' text in, `None` when not set. |
| `design_system` | `BrandingDesignSystem \| None` | The team's design system, a DTCG token document, `None` when there is none. |
| `white_label` | `bool` | Whether the organization holds the white-label entitlement. |

A `BrandingColors` always carries its three fields, each `#rrggbb` in lower case or `None` when not set: `action` is the button colour, `accent` the accent colour and `header` the header band's colour. A dark colour that is `None` falls back to the light colour of the same role, and a light one that is `None` to Pipelex's own palette for that theme.

**The preset, the shell and the typeface.** `preset` is the id of the preset the team started its design system from, such as `corporate`; `shell` is the id of the page shell its method apps wear, such as `masthead`; `typeface` is the id of the typeface their text is set in, such as `manrope`. Both themes share them. The platform holds each to a shape, one to 32 lower-case letters, digits and hyphens (`^[a-z0-9-]{1,32}$`), and never to a list: the lists of presets, shells and typefaces live with the application that offers them, so a client reads an id it does not know as unset, and a preset or a shell added to that list needs no new SDK. None counts towards whether an app is branded, which stays a logo or a colour in either theme, since a branded app trades Pipelex's strip for the team's band and a preset alone would leave that band carrying nothing of the team's. The preset replaced the app style the branding carried before: the platform no longer answers `style`, and refuses a write naming it.

**The dark logos.** `dark_square_logo` and `dark_wide_logo` are the variants of the square and the wide logo a client draws in dark mode. A dark logo that is `None` falls back to the light logo of its slot, so a client draws the dark one in dark mode when there is one and the light one otherwise.

**The design system.** `design_system` is the team's DTCG token document (the Design Tokens Community Group format), typed `BrandingDesignSystem` (`dict[str, Any]`): the palette in both themes, typography, shape, depth, spacing, motion and the component treatments, or `None` when there is none. The application that writes it owns its format; the platform stores it as it was written, never reads a token, and checks only a shape it can check cheaply: a JSON object of at most 64 KiB of compact JSON, nested at most 32 objects deep, in which every member whose name does not start with `$` is a token or a group, so an object; an object holding `$value` is a token and holds no token or group of its own; a name holds no `{`, `}` or `.`, which DTCG reserves for references; and `$type` and `$description` are strings and `$extensions` an object wherever they appear. What a `$value` holds, which `$type` values exist and whether a reference resolves are the application's to check.

**The white-label entitlement.** `white_label` is `True` when the organization holds the white-label option: its method apps show no Pipelex mark anywhere a runner looks, whether or not the team set a brand. It is `False` for every other organization, a personal workspace included. It is not part of the brand the team sets: Pipelex staff grant and withdraw it, no branding write changes it, and `OrganizationBrandingUpdate` has no such field.

**A branding written before these fields existed** answers the dark logos, `preset`, `shell`, `typeface` and `design_system` `None` and `white_label` `False`. The client reads an answer that leaves any of them out, as a platform that predates them sends, the same way, as `@pipelex/sdk` reads it, and the branding still validates. It also reads `preset`, `shell` and `typeface` as `None` when the answer sends a value that is not a string, `design_system` as `None` when it is not a JSON object, and `white_label` as `False` unless it is `True`.

A `LogoDescriptor` is what the platform recorded when it accepted the logo:

| Field | Meaning |
|---|---|
| `uri` | The platform's own copy of the logo, `pipelex-storage://<org_id>/branding/<uuid>.<ext>`, never the upload URI the write sent: the platform copies every logo it accepts, under a fresh uuid each time, so the same bytes attached again get a new URI. Sending it back unchanged in its slot keeps the logo ([below](#writing-it)). `resolve_storage_url` turns it into a short-lived link to its bytes. |
| `sha256` | The SHA-256 of the logo's bytes, 64 lower-case hexadecimal digits, which serves as a cache key for them. |
| `content_type` | The type the platform read from the file's own bytes: `image/png`, `image/jpeg`, `image/webp` or `image/svg+xml`. |
| `width`, `height` | `float`s: the size in pixels for a raster, oriented as a browser draws it; for an SVG, its `width` and `height` in pixels when both are in absolute units, which is the size a browser draws it at, else the width and height of its `viewBox`; an SVG's may be fractional. Their ratio sizes the logo's box before the image loads. |

The response models are extension-open (`extra="allow"`), as every product model is, so a field a later platform adds is kept rather than refused.

## Writing it

Only the fields an `OrganizationBrandingUpdate` sets are sent: a value sets it, an explicit `None` clears it, and a field left unset keeps its value, so `OrganizationBrandingUpdate()` writes nothing and answers the branding as it stands. The model is closed (`extra="forbid"`), and so is `BrandingColorsUpdate`, so a misspelt field is refused when the update is built.

```python
from pipelex_sdk.product_models import BrandingColorsUpdate, OrganizationBrandingUpdate

# Set the button and accent colours, keep the header colour, clear the whole dark set,
# attach a square logo and its dark variant, remove the wide one, choose a preset and a shell,
# clear the typeface and replace the design system.
branding = await client.update_organization_branding(
    org_id,
    OrganizationBrandingUpdate(
        colors=BrandingColorsUpdate(action="#14213d", accent="#fca311"),
        dark_colors=None,
        square_logo="pipelex-storage://<org_id>/assets/<file>.png",
        dark_square_logo="pipelex-storage://<org_id>/assets/<dark-file>.png",
        wide_logo=None,
        preset="corporate",
        shell="masthead",
        typeface=None,
        design_system=design_system,  # a DTCG token document, a dict
    ),
)
```

- **Colours** (`BrandingColorsUpdate`): each of `action`, `accent` and `header` takes `#rrggbb` in either case, stored in lower case. `colors=None` or `dark_colors=None` clears all three colours of that set. The client does not check a colour itself: the platform does, and names the field it refused.
- **Logos**: `square_logo`, `wide_logo`, `dark_square_logo` and `dark_wide_logo` take one of three values, a dark logo held to its slot's rules as the light one is. The `pipelex-storage://` URI of a file the organization uploaded on its own (`upload`) sets a new logo: the platform reads and measures it, then writes its own copy under `branding/`, and the answer's `uri` names that copy, never the upload, which the platform leaves as it is. The `uri` the branding answers for that slot, sent back unchanged, leaves the slot out of the write: nothing is read, and the slot keeps whatever logo the branding names when the write lands, so a save that resends the logo it read never puts back one a concurrent save replaced. `None` removes the logo. Any other URI is refused as `logo_not_an_upload`: a run's or a method's file, a `branding/` copy the slot no longer holds, and another slot's logo too, so a logo cannot move between slots by its URI; upload it again for the other slot instead. Once the write has landed, the platform erases the `branding/` copy it replaced or cleared.
- **Preset, shell and typeface**: `preset`, `shell` and `typeface` each take an id of one to 32 lower-case letters, digits and hyphens, stored as it is whether or not such a preset, shell or typeface exists, or `None` to clear it. Writing one leaves the colours, the logos and the others as they are. The client does not check an id itself: the platform does, and names the field it refused. There is no `white_label` field, nor a `style` one, so an update naming either is refused when it is built, as the platform refuses a body naming it.
- **Design system**: `design_system` takes a DTCG token document, a `dict`, which replaces the stored one whole, or `None` to remove it. The client does not check its shape: the platform refuses one of another shape than the one [above](#the-branding) naming `design_system`, and writes nothing at all. The platform writes the rest of the branding first and the design system after it, so a `503` on that second write leaves the rest landed: the same `update` sent again is safe.
- **The rules a logo meets**: at most 1 MiB; a PNG, JPEG, WebP or SVG image by its bytes, whatever type the upload declared, an SVG in UTF-8 or, behind its byte-order mark, UTF-16; a still image, so never an animated PNG (an APNG) or an animated WebP; a raster of at most 4096 × 4096 pixels that decodes whole; a square logo's longer side at most 10% longer than its shorter, and a raster one at least 128 px on each side; a wide logo at least one and a half times as wide as it is tall, and a raster one at least 64 px tall. An SVG is measured from its root element, by its `width` and `height` when both are in absolute units, else by its `viewBox`, and each side must lie between 0.001 and 1,000,000, in pixels for a `width` or `height` and in the SVG's own units for a `viewBox`. It must declare no XML entities or external references and carry no active content: no `script` or `foreignObject` element, no element in the XHTML namespace, no `on…` event handler attribute, no `set` or `animate` that rewrites a link, no `xml-stylesheet` processing instruction, and no link but a reference inside the file (`#…`) or an embedded PNG, JPEG, GIF or WebP image (`data:image/…`), whether an `href`, an `xlink:href`, or a CSS `url()` or `src()`. Wherever a browser reads CSS, which is a `<style>` element's text and any attribute in no namespace or the SVG one, such as `style`, `fill` or `filter`, it must hold no `@import`, no `image()` or `image-set()`, and no escape (a backslash, which can spell a link out of sight). A `<style>` element itself is allowed, so the class-based styles a design tool exports pass, and so does a reference inside the file such as `fill:url(#grad)`; an attribute in another namespace, such as Inkscape's `inkscape:export-filename`, and a `data-*` one, such as the layer names Illustrator writes in `data-name`, are never read as CSS.

The write sends no `Idempotency-Key`, as `rename_organization` sends none. A later write that should keep a logo leaves its field unset, or sends back the `uri` the branding answered.

## When a write is refused

A refused write changes nothing, whichever part of it was refused, and raises an `ApiResponseError` whose `problem` is the platform's problem document; only a `503` leaves it unknown whether the write landed:

| Status | `problem.code` | When |
|---|---|---|
| `403` | `auth.forbidden` | The caller is a runner, or holds no recognised role in the organization. |
| `403` | `pipelex.org.mismatch` | `org_id` is not the caller's active organization, or a logo's URI is a file of another organization. |
| `404` | `pipelex.org.not_found` | The organization does not exist. |
| `409` | `pipelex.org.not_manageable` | The organization is a personal workspace, which has no branding. |
| `422` | `request.invalid` | A colour is not `#rrggbb`, a preset, a shell or a typeface is not an id of the shape `^[a-z0-9-]{1,32}$`, or the design system is not of the shape the platform holds it to. |
| `422` | `request.unsupported` | A logo was refused ([below](#a-refused-logo)). |
| `422` | `pipelex.storage.uri_invalid` | A logo's URI is not a storage URI. |
| `503` | `runtime.unavailable` | The platform's storage failed while reading or copying a logo, or its database failed or could not be reached, so the write may have landed or not. Its `retry` is `yes`: the same `update` sent again is safe, and `get_branding` reads what the branding holds. |

**A refused field is named by its `location.field`**, so a settings screen shows each sentence under the control it concerns: a colour by its dotted key, such as `colors.action` or `dark_colors.header`, and a preset, a shell, a typeface or the design system by its own key. When the write refuses one such field alone, the problem itself names it, in `problem.location.field` and in `problem.params.field`, and carries no `errors`; when it refuses several, it names the first and carries one `ProblemItem` per refused field in `errors`, each with its own `location.field`.

### A refused logo

**A refused logo is a `422` `request.unsupported`**, one problem for every logo of the body. It names the logo that broke the first rule in its `location.field` and `params.field`, the slot's key (`square_logo`, `wide_logo`, `dark_square_logo` or `dark_wide_logo`), and that rule in `params.reason`, one `LogoRefusalCode` (`pipelex_sdk.errors`) names. When several rules are broken, in one logo or across several, the problem also carries `errors`, one `ProblemItem` per broken rule, each with its own `location.field`, `params.field` and `params.reason`; a lone broken rule carries no `errors`. Every `detail` is the code's general sentence and never the measure: the platform keeps the sentences below for its logs, so a client writes the sentence it shows under a slot from the reason.:

| `params.reason` | `LogoRefusalCode` | What the platform logs, for example |
|---|---|---|
| `logo_not_an_upload` | `NOT_AN_UPLOAD` | The square logo must be a newly uploaded file (pipelex-storage://<organization>/assets/<file>) or the URI the square logo already has. |
| `logo_not_found` | `NOT_FOUND` | The square logo file was not found in the organization's uploads; upload it again. |
| `logo_too_large` | `TOO_LARGE` | The wide logo file is 2,048 KiB; a logo file can be at most 1 MiB (1,024 KiB). |
| `logo_type_not_accepted` | `TYPE_NOT_ACCEPTED` | The square logo file is a GIF image; a logo must be a PNG, JPEG, WebP or SVG image. (An animation reads "The square logo is an animated WebP; a logo must be a still image.", or "an animated PNG" for an APNG.) |
| `logo_unreadable` | `UNREADABLE` | The wide logo is an SVG that cannot be read: it is not well-formed XML. (An SVG side out of range reads "… its width or height lies outside the 0.001 to 1,000,000 px a logo's side may measure.", or "… its viewBox's width or height lies outside the 0.001 to 1,000,000 units a logo's side may measure." A raster reads "The square logo looks like a JPEG image but cannot be read: the file is damaged or incomplete.", its one frame being decoded whole so a file cut short is caught whatever its format, or "… at 5,000 × 5,000 px it has more than the 16,777,216 pixels (4096 × 4096) a logo may have.") |
| `logo_active_content` | `ACTIVE_CONTENT` | The square logo is an SVG that carries active content, which a logo may not: a \<script\> element. (Or: a \<foreignObject\> element; an element in the XHTML namespace; an event handler attribute (onload); a \<set\> element that rewrites a link; a link to something outside the file, where only a reference inside it or an embedded PNG, JPEG, GIF or WebP image is allowed; an xml-stylesheet processing instruction, which loads a style sheet; a CSS @import, which loads a style sheet; a CSS url() that links to something outside the file, where only a reference inside it or an embedded PNG, JPEG, GIF or WebP image is allowed, which reads "a CSS src()" for `src()`; a CSS image-set() function, which can load an image from outside the file, which reads "a CSS image() function" for `image()`; a CSS escape (a backslash), which can disguise a link.) |
| `logo_not_square` | `NOT_SQUARE` | The square logo is 640 × 512 px, 1.25 times as wide as it is tall; a square logo's longer side can be at most 10% longer than its shorter side. |
| `logo_too_small` | `TOO_SMALL` | The square logo is 100 × 100 px; a square logo must be at least 128 px on each side. |
| `logo_not_wide` | `NOT_WIDE` | The wide logo is 600 × 500 px, 1.2 times as wide as it is tall; a wide logo must be at least 1.5 times as wide as it is tall. |
| `logo_too_short` | `TOO_SHORT` | The wide logo is 240 × 48 px; a wide logo must be at least 64 px tall. |

The two refusals of a logo URI that come before any file is read, `422` `pipelex.storage.uri_invalid` and `403` `pipelex.org.mismatch` for another organization's file, name the slot in the problem's own `location.field`, with no `errors`. So one slot's refusals are read the same way in every case: the problem's `errors` when it carries some, else the problem itself, kept when its `location.field` is the slot.

```python
try:
    await client.update_organization_branding(org_id, OrganizationBrandingUpdate(square_logo=uri))
except ApiResponseError as exc:
    problem = exc.problem
    refusals = problem.errors or [problem]
    under_square = [
        (refusal.params.as_wire().get("reason") if refusal.params is not None else None) or refusal.code
        for refusal in refusals
        if refusal.location is not None and refusal.location.field == "square_logo"
    ]
    # Write a sentence for each reason under the square logo's slot; an error naming no field goes elsewhere.
```

`get_branding` raises `403` `pipelex.org.required` when the caller has no active organization and `404` when its organization's row is missing. Either method raises the `ApiResponseError` of an answer it cannot read for a `2xx` that is not the branding, an empty one included.
