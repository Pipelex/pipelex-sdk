# A method's stored layouts

A **layout** is a data file a producer designed for one pipe of a method: a tree of elements written in the vocabulary of a catalog of components, every value bound to a path in the host's form state, carrying no field descriptions and no data of its own. A host renders it over the input-form descriptor the same method's validate projects, and renders the plain form instead whenever it cannot. The hosted platform stores layouts beside a method's published versions and hands them back, on a direct read by the version or on a validate of the method by id, so a method laid out once opens with its layout for everyone who opens it. It never produces a layout, never parses one and never judges one against a catalog or a descriptor: that is the producer's work before the write and the host's before it renders.

The client reaches the write on the hosted API's `POST /v1/methods/{method_id}/versions/{version}/layouts`, the direct read on `GET` of the same route, the read through `POST /v1/validate` under the `layouts` view, and the off switch on `PUT /v1/methods/{method_id}/layouts-off`. The types are in `src/method-layouts.ts`, exported from the package's root: `MethodLayoutInput` and `LayoutProvenanceInput` for the write, `MethodLayout` and `LayoutProvenance` for what is stored, and `MethodLayoutList` for the direct read. The storage and the `layouts` token are a Pipelex hosted feature; the shapes are stated brand-neutrally, snake_case with no `pipelex_` prefix, as the input-form descriptor they are rendered over is. The conformance spec `pipelex-hosted-method-layouts.md`, in the workspace's `conformance` repository, states the contract.

```ts
import { PipelexApiClient } from "@pipelex/sdk";
import type { MethodLayout } from "@pipelex/sdk";

const client = new PipelexApiClient();

// A producer has designed a layout over version 3's descriptor: store it beside that version.
const version = await client.getMethodVersion("mt_abc123", 3);
// The producer model's JSON patch lines, carried as emitted.
const jsonl = '{"op":"add","path":"/root","value":"page"}';
// One key per layout to store, made once and sent again unchanged on each retry of this write.
const layoutKey = crypto.randomUUID();
await client.storeMethodLayout(
  "mt_abc123",
  3,
  {
    tree_digest: version.tree_digest!, // the tree the layout was designed over
    pipe_ref: "receipts.review_receipt",
    catalog: "composer",
    prompt_hash: "a1b2c3d4e5f6",
    jsonl,
    provenance: { producer: "pipelex-method", model: "claude-4.8-opus", style: "editorial" },
  },
  { idempotencyKey: layoutKey },
);

// A host reads the descriptor and the layouts over it in one call.
const report = await client.validate({ method_id: "mt_abc123@3" }, false, {
  views: ["input_form", "layouts"],
});
if (report.is_valid) {
  const layout: MethodLayout | undefined = report.layouts?.find(
    (candidate) =>
      candidate.pipe_ref === "receipts.review_receipt" && candidate.catalog === "composer",
  );
  // No layout, or none the host can render: the plain form over `report.input_form`.
}
```

## The layout

| Member | Meaning |
|---|---|
| `tree_digest` | The digest of the method tree the layout was produced against, the MTHDS standard's `sha256:` digest of the tree's listing: `sha256:` and 64 lowercase hexadecimal characters. |
| `pipe_ref` | The namespaced pipe reference it lays out, `domain_path.pipe_code`, as the input-form descriptor keys its forms. |
| `catalog` | The id of the catalog whose vocabulary it is written in, a slug such as `composer`. |
| `prompt_hash` | The hash of the prompt the producer's model read, 12 to 64 lowercase hexadecimal digits, so a host recognises a layout designed under an older recipe. |
| `jsonl` | The layout itself, as the producer's model emitted it: JSON patch lines, one per line, carried as one string exactly as written. |
| `provenance` | How it was made: `producer`, `model`, `seed`, `style` and `repair_rounds` (below). |
| `stored_at` | The moment the write landed, ISO 8601 in UTC. The one member the platform sets, absent from the write. |
| `sample_json` | A written sample of the result the layout was designed over, one JSON text, or `null` when none was stored (see [The written sample](#the-written-sample)). |

| `provenance` member | Meaning |
|---|---|
| `producer` | Who produced the layout, a slug of the same shape as `catalog`, such as `pipelex-method`. |
| `model` | The id of the model the producer ran, such as `claude-4.8-opus`. |
| `seed` | The creative seed handed to the model with the brief, verbatim, or `null` when none was. |
| `style` | The id of the app style the layout was designed under, such as `editorial`, or `null` when it was designed under none. The platform holds it to the shape `^[a-z0-9-]{1,32}$` and never to a list of styles, so a host reads an id it does not know as no style. |
| `repair_rounds` | How many repair rounds the producer ran before the layout validated against its catalog. |

**A layout belongs to the content it was designed for, never to a version number.** Its identity is `tree_digest`, `pipe_ref`, `catalog` and `prompt_hash` within one method, and it names no method and no version. It is written against a published version, and served for whatever selector of that method resolves the same tree: the version it was written against, a later version that holds the same tree, or the draft while it holds it. A publish that writes a new version also carries the previous version's layouts forward, each copied under the new tree as it stood, so a design follows the method; a host's checks decide whether one still fits. The same tree saved as another method carries none of it, and a copy of a method takes no layout.

## Storing a layout

| Method | Route | Answer |
|---|---|---|
| `storeMethodLayout(methodId, version, layout, options?)` | `POST /v1/methods/{id}/versions/{n}/layouts` | The `MethodLayout` as stored, with its `stored_at`. |

It takes a bare catalog id, as every method route does, and refuses a suffixed one (`mt_…@3`) with a `RequestArgumentError` before anything is sent; `version` is the number of the published version the layout was designed for, and a value that is not a positive integer is refused the same way.

**The body is closed at both levels.** The client sends `tree_digest`, `pipe_ref`, `catalog`, `prompt_hash`, `jsonl` and `provenance` with its `producer` and `model`, and `sample_json` and the provenance's `seed`, `style` and `repair_rounds` when each is given and not `null`, and nothing else. A layout read back can be passed as it is: its `stored_at` is left out. A layout or a provenance that is not an object is refused with a `RequestArgumentError` before any request; every other member is sent as given, and the platform holds it to its shape.

**`tree_digest` must be the tree the version holds**, its `MethodVersionSummary.tree_digest`, which `getMethodVersion` and `listMethodVersions` read: a producer designs over the descriptor of the version it was handed, so a layout stating another tree describes content the version does not hold, and is refused.

**A write of the same identity replaces the layout**, its sample included, so a write that sends no `sample_json` stores none. The answer is the same `200` whether the write stored a new layout or replaced one, and the replaced layout is carried no more.

**A write is sent again under its idempotency key.** `options.idempotencyKey` (`MethodLayoutWriteOptions`) is sent as the `Idempotency-Key` header, and nothing is sent when it is absent or `null`. Under the same key the hosted API answers a retry with the first write's stored answer and runs nothing, so a write whose answer was lost, on a client timeout for instance, is sent again unchanged under the key it was first sent with. Without a key the write runs again: it stamps the layout with a new `stored_at`, which moves it ahead of every layout stored since in the newest-first order, and applies the bound below again, so when another producer stored a newer prompt of the same pipe and catalog meanwhile, the resent layout can come back ahead of it and, at the bound, that newer layout can be the one removed. Generate one key per layout to store, a `crypto.randomUUID()` for instance. The write's `200` and its `4xx` refusals are stored under the key alike; a `5xx` and a refusal for its timing (a `408`, `425` or `429`) are not, so the same key sends the write afresh, and neither are the key's own `409` answers below, so a retry after `request.idempotency_key_in_use` runs as the key's first request would. A key is 1 to 255 visible ASCII characters, and anything else is a `RequestArgumentError` before any request.

**A content keeps at most 16 layouts**, every pipe, catalog and prompt hash together, which is also the most a validate carries. Past the bound, a write removes first the layouts that newer prompt hashes of their own pipe and catalog superseded, the most superseded and then the oldest first, and the last layout of a pipe and catalog leaves only once more than 16 pipes and catalogs hold layouts. A host laying out several pipes, each in a composer and a result catalog, keeps every one's current layout while another takes new prompts.

**Who may write.** The write changes the method, so it takes the roles that change methods: an `admin` or a `member` of the method's organization. A `runner` is refused.

## The written sample

A designed result page needs something to draw before anyone has run the method, so a layout may carry a sample of its result: `sample_json`, one JSON text of at most 64 KiB of UTF-8, which the platform stores and never reads, refusing it on write when it does not parse. **Only a written sample belongs here, invented from the description of the result and holding no customer's data, never a run's output.** A layout's readers include the method's runners and, for a public method, other organizations, and since the platform never reads the sample, keeping that rule is the producer's. The client reads a `sample_json` that is missing or not a string as `null`, and hands the text back as it is: a host parses it and checks it itself.

## The refusals

Each is an `ApiResponseError` carrying the platform's problem, and none stores anything. Branch on its `code`, never on the status.

| Status | `code` | When |
|---|---|---|
| `422` | `request.invalid` | A member breaking its shape or bound, named in the problem's `params.field` and `location.field`, `provenance.<member>` for one of the provenance's: a missing member, a `tree_digest` that is not `sha256:` and 64 lowercase hexadecimal characters, a `pipe_ref` that is not a dotted reference or is over 256 characters, a `catalog` or `producer` that is not a slug, a `prompt_hash` that is not 12 to 64 lowercase hexadecimal digits, an empty `jsonl`, one over 128 KiB of UTF-8 or one holding a raw control character other than the tab, the line feed and the carriage return, a `model` that is empty, over 128 characters or holds a control character, a `seed` over 4,000 characters, a `style` off its shape, a `repair_rounds` outside 0 to 100, a `sample_json` over 64 KiB of UTF-8 or that is no JSON text, and a lone UTF-16 surrogate in `jsonl`, `model`, `seed` or `sample_json`. |
| `422` | `request.invalid` naming `tree_digest` | `tree_digest` is not the digest of the tree the version holds. |
| `403` | `auth.forbidden` | A `runner`, or a caller with no recognised role; its `params.requirement` is `member`. |
| `404` | `pipelex.catalog.not_found` | No such method in the caller's organization, another organization's included, its `params.resource` `method`; or a version the method never published, its `params.resource` `version`. |
| `409` | `pipelex.catalog.being_deleted` | The method's erasure is pending, under way or stopped. |
| `409` | `request.idempotency_conflict` | The idempotency key was sent before with a different body; its `retry` is `no`. |
| `409` | `request.idempotency_key_in_use` | The key's earlier request is still being handled; its `retry` is `yes`, under the same key in a few seconds. |
| `500` | `runtime.unexpected` | The version was stored before methods were trees and names no tree, so it takes no layout. |

An answer that does not read as a layout, one whose `tree_digest`, `pipe_ref`, `catalog`, `prompt_hash`, `jsonl` or `stored_at` is not a string, or whose `provenance` is not an object with a string `producer` and `model`, is an answer the SDK cannot read, thrown as an `ApiResponseError` coded `client.response_unreadable` whose message names the member.

## Reading a version's layouts

| Method | Route | Answer |
|---|---|---|
| `listMethodLayouts(methodId, version, options?)` | `GET /v1/methods/{id}/versions/{n}/layouts` | A `MethodLayoutList`, whose `items` are the layouts stored for the version's content, newest first, at most 16, empty when none is. |

This is what a host calls when it opens a method's page. It touches only the platform's database and calls no runner, where the `layouts` view below dry-runs every pipe of the method to return the same list. It takes a bare catalog id and a positive integer version, each refused with a `RequestArgumentError` before anything is sent, and `options.signal` cancels the read, for a page that can do without its layouts. A `runner` reads what it is shown, another organization's public method answers the layouts its builders stored, and the answer ignores `layouts_off`, which is the host's to honour.

Its refusals are `ApiResponseError`s: `404` `pipelex.catalog.not_found` for an unknown method, another organization's internal one (`params.resource` `method`) and a version never published (`params.resource` `version`); `409` `pipelex.catalog.being_deleted` during the erasure of the caller's own method; `500` `runtime.unexpected` for a version stored before methods were trees. `items` is read entry by entry, by the rule below, so an entry that does not read as a layout is left out; an answer whose `items` is not an array is one the SDK cannot read.

```ts
const { items } = await client.listMethodLayouts("mt_abc123", 3, {
  signal: AbortSignal.timeout(5000),
});
```

## Switching a page's design off

A builder can turn a page's design off and on, per catalog, without losing it. The state is `layouts_off`, the catalog slugs whose layouts no host draws, read on `MethodData`, `MethodDetail` and `PublicMethodDetail` and absent from a platform that predates it, which means none.

| Method | Route | Answer |
|---|---|---|
| `setMethodLayoutsOff(methodId, catalogs, options?)` | `PUT /v1/methods/{id}/layouts-off` | The method, its `layouts_off` the list as held. |

`catalogs` is the whole list and replaces the one held, so changing one catalog means reading `layouts_off` and writing the new list; an empty list switches every design on. The switch acts at once with no publish and holds across every publish, and a layout switched off is kept: `listMethodLayouts` and the `layouts` view still answer it, and the host draws the plain page. Like a rename, the write never moves the draft token, so the `updated_at` a caller holds stays valid.

**The last write to land is the one held.** A write sent again without a key writes its list again, and so undoes a switch that landed in between. `options.idempotencyKey` (`MethodLayoutsOffOptions`) is sent as the `Idempotency-Key` header, so a write whose answer was lost is sent again under its key and answered as the first was, by the rule [a layout write](#storing-a-layout) follows.

A `catalogs` that is not an array is a `RequestArgumentError` before any request, and its entries are sent as given. The route's body is closed, and the platform answers: `422` `request.invalid` for more than 8 catalogs, a catalog named twice or one that is not a slug; `403` `auth.forbidden` for a `runner`; `404` `pipelex.catalog.not_found` for an unknown method or another organization's, a public one included; `409` `pipelex.catalog.being_deleted` during the erasure; and `413` `request.too_large` for a list that would leave the method too large to publish, which a list that does not grow never is, so switching a design back on is always reachable.

## Reading the layouts: the `layouts` view

A host that is already validating the method can read its layouts on the same call, at the cost of the validate's dry run. A `validate` naming a stored method by `method_id` (`mt_…`, `mt_…@<n>` or `mt_…@draft`) and naming `layouts` among its `views` is answered, on the valid report, with `layouts`: every layout stored for the tree the selector resolved, newest first by `stored_at`, at most 16. Ask for `views: ["input_form", "layouts"]` to receive the descriptor and the layouts over it in one answer. `ValidateView` types the tokens this SDK knows, `input_form`, `output_form` and `layouts`, and `ValidateOptions.views` still takes any other token as its raw string.

The token rides the `views` list with that list's mechanics: the client sends it verbatim and only when asked, a runner that does not know it ignores it, and it never causes a `422`. The platform forwards `views` as sent and adds the member to the runner's answer.

**Absent means none.** `PipelexValidationReport.layouts` is optional, and the platform leaves it out, so a host renders the plain form, whenever:

- the validate names no `method_id`, since a method sent as its tree has no stored layouts, whatever its tree;
- `views` does not name `layouts`;
- the verdict is invalid, since a layout is rendered over the descriptor and the descriptor rides the valid report alone;
- no layout is stored for the resolved tree;
- the platform could not read the stored layouts, which costs the validate nothing else.

A host therefore never reads an empty array here. Publishing a version with another tree leaves the layouts of the old tree where they were, and the old version named by its number still carries them all; the new tree carries the copies the publish made of them. Another organization's public method carries the layouts its holder's builders stored.

**The client reads `layouts` entry by entry**, as it reads a verdict's problem items, so one layout it cannot read never costs the caller the verdict or the other layouts: an entry that does not read as a layout, by the rule the write's answer is held to, is left out, and a list left with none is removed. In each entry, a `sample_json` or a provenance `seed` or `style` that is missing or not a string reads as `null`, and a `repair_rounds` that is missing or not a non-negative integer reads as `0`, the platform's own defaults; the write's answer and the direct read's entries are read the same way.

**Discovery.** `GET /v1/version` lists `method_layouts` among its `extensions` once the platform stores layouts and carries the view. Without it, a validate answering no `layouts` cannot tell a method nobody laid out from a platform that ignores the token, so a host that does not find it offers no layout to produce, since the write would be refused, and renders the plain form. The SDK types no member for it: read it off `version()`, whose answer keeps every extension member as the server sent it.

```ts
const info = await client.version();
const storesLayouts =
  Array.isArray(info.extensions) && info.extensions.includes("method_layouts");
```

## What a host does with a layout

A host renders a layout only when it can, and renders the plain form over the descriptor otherwise. It sets a layout aside when it does not render its `catalog`, when it no longer accepts its `prompt_hash`, when the layout's `pipe_ref` is not the pipe it is showing, or when the layout no longer fits the descriptor, such as a binding to a path the descriptor does not hold. Among the layouts it can render it picks one by its own rule, which may read `provenance.style` to prefer the layout designed under the style it shows. A host never sends a layout back, and never fails the page for want of one.
