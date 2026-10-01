# A result view of the method's own

Every method `make add-method` scaffolds renders its result through `<RunResult>`, the form kernel's view of whatever the method's output-form descriptor says it produces ([`docs/input-form.md`](input-form.md#the-result-view-the-same-idea-on-the-way-out) explains how). That view is right for every method on the day it is added, because it needs nothing written. It is also generic: field labels are the field names humanised, an enum value is shown as its code, and a number is printed as it arrived. A result that a person reads to make a decision usually earns a view written for it, and this page is how to write one without giving up what the generated view guarantees.

## Where it goes

Write the view as a component of its own, `src/components/<Pascal>Result.tsx`, and render it in the `done` branch of `src/components/<Pascal>Form.tsx`, which `make add-method` wrote and which is yours to edit. Keep `<RunDetails>` under it: that is where the run's id and its cost live.

```tsx
{
  state.phase === "done" && (
    <>
      <InvoiceReviewResult output={state.output} />
      <RunDetails runId={state.runId} usage={state.usage} />
    </>
  );
}
```

## Take the typed output, never the payload

`state.output` has already been through the method's generated binder, so it is typed: the adapter in `src/types/<camel>Pipeline.ts` re-exports the output type from `src/generated/<name>/types.ts`. Declare the view's prop with that type.

```tsx
import type { InvoiceReviewOutput } from "@/types/invoiceReviewPipeline";

export function InvoiceReviewResult({ output }: { output: InvoiceReviewOutput }) {
  // …
}
```

That is what keeps the view honest when the method changes. After an edit to the method and `npm run codegen`, a field that was renamed or removed is a type error in the view rather than an empty cell on screen. For the same reason, never work out what a value is by inspecting it: the type says what it is. Field names stay the wire's snake_case (`po_number`, `line_items`), as everywhere else in the app.

## Say things the way a reader would

- **Enum values** already read as words in the generated view (`hold_for_review` reads "Hold for review"), worded from the code. A view of your own that wants the method's own wording gets its labels from a map keyed by the enum itself, so adding a value to the method makes a missing label a type error: `const STATUS_LABELS: Record<InvoiceReviewOutput["status"], string> = { … }`.
- **Numbers** go through `Intl.NumberFormat`: grouping, a fixed number of decimals, and the currency when the method's output says which one. A value that is a judgment rather than an amount (a score out of five, a confidence) usually reads better as words or a bar than as a number.
- **Text the model wrote as Markdown** is rendered with the kernel's own `<Markdown>` component, from `@pipelex/mthds-form/react`, rather than a Markdown library of your own. It renders an image in the model's answer, `![](https://…)`, as a link rather than fetching it when the page paints, because a model talked into writing one would otherwise make the reader's browser call an address of its choosing. Its `proseImages="load"` prop turns that off; pass it only for prose whose images you know the origin of.
- **A long list of records** shows the few columns a reader decides on, and puts the rest in a detail row or a second view. The generated table already keeps five columns, chosen by rank — the record's name first, then the fields that fit a cell whole — in the order the concept declares them, and opens a row to the whole record. A view of your own can choose by meaning instead.

## Files go through the kernel's URL gate

A file the run produced arrives as a `pipelex-storage://` reference in `url`, beside a signed `public_url` that expires within minutes and is itself the credential to the object. Paint the reference, never the signed link: `assetPath(url)` from `src/lib/storageAsset.ts` turns it into this app's own `/api/assets/…` path, which streams the file on the server under the headers `src/lib/assetHeaders.ts` sets. A view that paints any other URL from the payload judges it with the kernel's `viewableUrl`, from `@pipelex/mthds-form`, and hands the element the string it returns rather than the payload's own: the gate returns the normalised URL it accepted, so the string it judged and the string the browser receives cannot differ, and it refuses what `<RunResult>` refuses, an SVG or HTML `data:` URL included. Frame a document only at an `https:` URL or a path `assetPath` produced, never at a path the payload names, since a path is this app's own origin.

## Keep the generic view within reach

The generated view is still the fastest way to see everything the run returned, including its JSON. A view of the method's own can keep it for whoever built the app, folded away:

```tsx
<details>
  <summary>Everything the run returned</summary>
  <RunResult field={RESULT_FIELD} value={state.output} name="invoice_review" />
</details>
```
