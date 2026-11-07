# Public methods and the template catalog

A stored method is `internal` by default: only the members of the organization that holds it see it. An admin of the platform can make one `public`, and every organization then reads, runs and copies its published versions, while every write stays the owner's. Users see the capability through the template catalog: the public methods of the organization the deployment names as its templates organization, which every organization reads the same. No route of this client makes a method public or writes the catalog's order; both are the platform's admin surface. The models are in `pipelex_sdk/product_models.py`. This page is the twin of `@pipelex/sdk`'s `docs/public-methods.md`.

```python
from pipelex_sdk.client import PipelexAPIClient

async with PipelexAPIClient() as client:
    page = await client.list_method_templates(ordering="default", category="finance", limit=8)
    for tab in page.categories:  # every category with a template
        print(tab.slug, tab.label)
    for template in page.items:
        card = template.thumbnails[0] if template.thumbnails else None  # pick the one closest to the shape you draw
        print(template.name, template.description, card.url if card else None)
    # A template copies into a team the caller may change methods in, from its latest published version.
    copy = await client.copy_method(page.items[0].method_id, destination_org_id="org_team")
```

## The catalog

| Method | Route | Answer |
|---|---|---|
| `list_method_templates(*, ordering=None, category=None, limit=None, cursor=None)` | `GET /v1/method-templates` | A `MethodTemplatePage`: `items`, `next_cursor`, `ordering`, `categories`. |
| `iterate_method_templates(*, ordering=None, category=None, limit=None)` | the same, following the cursor | Every `MethodTemplate`, in the order served. |

**The order is the platform's.** An ordering is a named list an admin writes, such as `default` or one arm of a test. The templates it lists lead, in its order, and every other template follows by name, so a template appears as soon as it is public. `ordering` asks for one by name; an absent, unknown or malformed name serves `default`, and the page's `ordering` names the one served, `None` when there is none, the templates then listed by name. A client never sorts the cards: it keeps the order served.

**A category filters and keeps the order.** `category` takes a slug of the catalog's list, such as `human-resources`, and keeps that category's templates in the same order; a slug no template shows keeps none. Whatever the filter, the page's `categories` names, in the catalog's order, every category at least one template shows, each a `MethodCategory` with its `slug` and its English `label`, so a tab bar drawn from it never shows an empty tab. A client translating the labels translates by slug and falls back on the label.

**A card is the latest published version.** Each `MethodTemplate` carries `method_id`, `name`, `description` (`None` when it has none), `latest_version`, `categories` (slugs), `organization_name`, the display name of the organization holding it, and `thumbnails`, each a `MethodTemplateThumbnail`: the image's `path`, `media_type`, `width`, `height` and `sha256`, with a `url` signed by storage and its `expires_at`, about fifteen minutes after the read. The ratio is never declared: draw the thumbnail whose `width` and `height` come closest to your frame. The link is a bearer credential until it expires, so it stays out of logs and stored records: the model leaves `url` out of its `repr`, and an answer the SDK cannot read is raised with its links redacted.

**Paging.** A page holds 50 templates by default and at most 200; a `limit` outside 1 to 200 is a `422` `request.invalid`. `next_cursor` resumes after the last template the page served, wherever the catalog now places it, so a template added or removed elsewhere between two pages neither repeats nor skips the ones around that point. The cursor holds neither the ordering nor the category: pass both again with it, as `iterate_method_templates` does. A cursor of another listing is a `422` `request.invalid` and one that does not decode a `422` `request.malformed`.

**Refusals.** `500` `runtime.misconfigured` when the templates organization the deployment names has no record or a link cannot be signed, and `503` `runtime.unavailable`, safe to retry. A deployment that names no templates organization serves an empty catalog.

## Reading another organization's public method

A template is a public method, so its `method_id` opens on the method routes of every organization:

| Method | From another organization |
|---|---|
| `get_method(method_id)` | A `PublicMethodDetail`: the latest published version, never the draft |
| `list_method_versions(method_id)`, `get_method_version(method_id, n)` | The published versions, each without `published_by` |
| `start`, `execute`, `start_and_wait_for_result` with `method_id` | The bare id or `mt_…@<n>` runs, belongs to and is billed to the caller's organization; `mt_…@draft` is `404` |
| `copy_method(method_id, …)` | A copy of the latest published version (below) |
| `write_draft`, `rename_method`, `publish_method`, `delete_method`, the examples | `404` `pipelex.catalog.not_found`: every write is the owner's |

**`get_method` answers the owner's model or the public one**, typed `MethodDetail | PublicMethodDetail`. The caller's own method reads whole, as before. Another organization's public method reads in a narrower shape: `method_id`, `org_id` (the organization holding it), `name`, `created_at`, `visibility`, and the latest published version's `description`, `categories`, `latest_version` and `latest_published`, with `files`, that version's tree, linked in the holding organization, which `write_method_tree` writes as any listing. It carries nothing of the draft or of the owner's people: no `updated_at`, `draft_digest`, `input_data`, `pipe_output`, `created_by_user_id`, `copied_from` or `deletion_state`. The draft's token `updated_at` and the members only the owner's read has are what tell them apart on the wire, and `pipelex_sdk.product_models.read_method` reads a body into the right model: an answer carrying any owner-only member is validated as a `MethodDetail`, so one that lost its token is refused rather than passed off as a public method. Narrow on the class before reading the draft:

```python
from pipelex_sdk.product_models import MethodDetail, MethodDraftInput

method = await client.get_method(method_id)
if not isinstance(method, MethodDetail):
    # Another organization's public method: read it, run it, copy it.
    return method.latest_version
await client.write_draft(method.method_id, MethodDraftInput(contents=contents, expected_updated_at=method.updated_at))
```

**A version read leaves out its publisher.** `MethodVersionSummary.published_by` is optional, `None` when absent, for that reason: the publisher's user id no more crosses organizations than the method's `created_by_user_id` does.

**What reads as not found.** An unknown id, another organization's internal method, and a public one made internal again or being erased all answer `404` `pipelex.catalog.not_found`, alike. A method made internal is closed at once, even before the platform's index has caught up.

## Copying a public method

`copy_method` of another organization's public method copies from its **latest published version**, never its draft: that version's tree, description and categories, and the method's saved examples, but not the owner's form inputs. The copy's `copied_from` names the `version` it took, its `draft_digest` `None`. Leave `expected_draft_updated_at` out: the caller never saw that method's draft, and the field sent with it is refused with a `422` `request.invalid` naming it. The rest of the copy, its verdict and its refusals, are [method-copy.md](./method-copy.md)'s.

## Visibility, categories and thumbnails on a method

- **`visibility`**, on every method read (`MethodData`, `MethodDetail`, `PublicMethodDetail`): a `MethodVisibility`, `INTERNAL` or `PUBLIC`, read open, so a value a later platform adds arrives as its raw `str`. Absent from a platform that predates it, which means `INTERNAL`. The list rows (`MethodSummary`) do not carry it.
- **`categories`**, on a method and on each version summary: the slugs the manifest declares under `[package]` that are on the catalog's list, in their declared order. The platform ignores a value it does not know, so a typo reads as no category.
- **`thumbnails`**, on each version summary: the valid images directly under the tree's `thumbnails/` folder, each a `MethodThumbnail` (`path`, `media_type`, `width`, `height`, `sha256`), measured by the publish. A PNG, JPEG or WebP of at least 800 by 400 pixels is valid; an invalid image is simply not recorded.
- **`description`**: the manifest's `description`, else the primary bundle's top-level `description`, else its main pipe's, a blank one counting as none at each step.

## Publishing a public method

A public method's publish is held to more than any draft's, so that a template's card never loses its picture and every organization can run what it reads. On top of `INVALID` and `NOT_RUNNABLE`, its `MethodPublishRefused` verdict may carry:

| `reason` | When |
|---|---|
| `STORAGE_REFERENCE` (`storage_reference`) | A `.mthds` file of the draft names a `pipelex-storage://` file, which other organizations cannot read. |
| `THUMBNAIL_MISSING` (`thumbnail_missing`) | The draft's tree holds no file directly under `thumbnails/`, or none was read within the publish's time; a retry may read them in time. |
| `THUMBNAIL_INVALID` (`thumbnail_invalid`) | No file directly under `thumbnails/` is a valid thumbnail. |

Each is a verdict, a `200` with a `message` for a person and the runner's valid `validation`, never a raised error. `MethodPublishRefused.reason` is read open, typed `MethodPublishRefusalReason | str`: a reason a later platform adds arrives as its raw `str`, still a verdict, so a client shows its `message` when it does not handle the reason. An internal method's publish never meets the reasons of this table. A method made public while its publish ran is a `503` with nothing written, safe to retry.
