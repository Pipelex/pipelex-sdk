# Input forms: rendered from the method, not written by hand

This is the reference for how the demo forms are built — why none of them names its own inputs, how the browser and the server share one set of validation rules, and what the styling setup is doing. The last section covers the mirror image, [the result view](#the-result-view-the-same-idea-on-the-way-out), which is the same argument applied to the other side of the same contract. The day-to-day rules live in [`CLAUDE.md`](../CLAUDE.md); this document is the "why" behind them, and its companion is [`docs/codegen.md`](codegen.md), which owns the artifact these forms read.

## Why

The same argument as [codegen](codegen.md), one layer up. A method's `.mthds` bundle already declares what it takes: variable names, concepts, which inputs are required. Before this, each demo form hand-rolled a `<textarea>` or a file picker for those inputs and hand-wrote a guard for each on **both** sides of the Server Action boundary. Every consumer who swapped in their own method inherited the obligation to write a form and to write its validation twice.

Now the form is derived from the method's own **wire input-form descriptor** — the standard's per-pipe, ordered presentation view of a method's inputs, requested from `POST /v1/validate` with `views: ["input_form"]` — with the IO contract co-walked beside it for the two facts the wire deliberately omits (the scalar content-wrapper key, a nested list's bounds). Swap the method, run `npm run codegen`, and the form follows — new inputs appear, renamed inputs relabel, a file input becomes a dropzone, and the Run button gates on whatever that method actually requires.

The kernel doing the deriving is [`@pipelex/mthds-form`](https://www.npmjs.com/package/@pipelex/mthds-form), which ships in two halves and this app uses both:

- **`@pipelex/mthds-form`** — the headless core. No React: the `RunField` descriptor, the derivation that produces it, the run gate, the wire format. Server-safe, which is what lets the browser and the Server Action take their input rules from one implementation.
- **`@pipelex/mthds-form/react`** — the themed control set: `FieldRenderer` and the per-kind controls it dispatches to.

Import from those two specifiers only. Never reach into `dist/`.

## The contract artifacts

`fieldsForContract(contract, descriptor)` consumes two payloads of one `POST /v1/validate` response: the pipe's IO contract (`pipe_io_contracts`) and its input-form descriptor (`input_form`, an opt-in structured view requested with `views: ["input_form"]`). The descriptor states what each field IS — kind, order, constraints, presence, gating — so the kernel maps it structurally instead of guessing from concept names and schema shapes; the contract is co-walked for the two facts the wire deliberately omits (the scalar wrapper key, a nested list's bounds) and is what the run gate validates against. This app takes both as one **committed codegen artifact** rather than a runtime fetch, so first paint needs no network and no API key: `npm run codegen` writes `src/generated/<method>/contracts.ts` alongside the types and the binder.

```ts
export const PIPE_IO_CONTRACTS: PipeIOContracts = {
  "extract_entities.extract_entities": {
    inputs: {
      text: {
        concept_ref: "native.Text",
        presence: "plain", // the authored marker, verbatim: plain | optional (?) | force (!)
        multiplicity: "single", // single | variable ([]) | fixed ([N])
        item_count: null, // non-null exactly when multiplicity is "fixed"
        json_schema: { … },
      },
    },
    output: { concept_ref: "extract_entities.ExtractedEntities", multiplicity: "single", item_count: null, optional: false },
  },
};

export const INPUT_FORM = {
  "extract_entities.extract_entities": {
    fields: [
      // one descriptor per declared input slot, in authored order
      { kind: "prose", name: "text", concept_ref: "native.Text", required: true, presence: "plain", gating: true },
    ],
  },
} as InputForm;
```

(`INPUT_FORM` is emitted with an `as` assertion rather than a `:` annotation, a documented workaround with an expiry: the deployed hosted engine still emits a `name` on a list's `item`, which the standard's closed shape forbids and tsc's excess-property check would reject. Fixed upstream in pipelex 0.54.0 — once the hosted engine carries it, the emitter reverts to an annotation. See `renderContracts` in `scripts/lib/shared.mts`.)

Both maps are keyed by **namespaced pipe ref** (`<domain>.<pipe_code>`), so entries are looked up rather than indexed:

```ts
const CONTRACT = requireContract(PIPE_IO_CONTRACTS, "extract_entities", "extract_entities");
const DESCRIPTOR = requireInputForm(INPUT_FORM, "extract_entities", "extract_entities");
```

`requireContract` (`src/lib/runInputs.ts`) wraps the kernel's `getPipeIOContract` — **contracts, then domain, then pipe code** — and throws when it misses; `requireInputForm` is its twin over `getPipeInputForm`, same argument order. The wrappers earn their place: the kernel returns `undefined` on a miss, and `fieldsForContract` returns `[]` unless both artifacts are present — so a missed lookup renders as an empty form with a live Run button, which reads like a styling bug rather than a typo. Both the form and its Server Action call `requireContract` at module scope (the form additionally `requireInputForm`), so a bad lookup fails at import.

Drift is covered the same way the rest of the tree is: `contracts.ts` carries no codegen stamp (it is not the codegen server's output), so its SHA-256 rides in the `sources.json` sidecar's `derived` map, and `npm run codegen:verify` re-fetches `/v1/validate` — with the same `views` opt-in — and compares the rendered bytes. See [`docs/codegen.md`](codegen.md).

## The three pieces in the app

| File                               | What it owns                                                                                                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/hooks/useRunInputs.ts`        | Form values, the derived `fields`, readiness, and the wire shape. The companion to `useRun`: this one owns what goes **in**, `useRun` owns the run and what comes **out**.           |
| `src/components/RunInputsForm.tsx` | The kernel composition, purely presentational — `FieldRenderer` per field, empty optionals folded behind `OptionalToggle`, all under `FieldPresentationProvider presentation="app"`. |
| `src/lib/runInputs.ts`             | `requireContract`, `requireInputForm` and `gateRunInputs` — the server-side gate, and the mapping from an invalid verdict to a `PipelineError`.                                      |
| `src/lib/resultField.ts`           | `requireResultField` — the output half's one lookup, pairing the output-form descriptor with the payload schema into a `RunField`.                                                   |
| `src/components/RunResult.tsx`     | The kernel composition on the output side — `<StuffViewer>` under the same `presentation="app"`, inside a labelled `<section>`.                                                      |

A form is then two lines of wiring plus its own chrome:

```tsx
const { fields, values, setValues, ready, toData } = useRunInputs(CONTRACT, DESCRIPTOR, {
  initialValues: { text: SAMPLE_TEXT },
});
// …
<RunInputsForm fields={fields} values={values} onValuesChange={setValues} disabled={running} />
<button type="submit" disabled={running || !ready}>Extract entities</button>
```

`presentation="app"` is the kernel's own seam for a use-facing surface: labels become humanized questions (`image_prompt` → "Image prompt") and the concept pills disappear, because `native.Text` is implementation detail to somebody filling in a form. The `studio` presentation shows the identifier verbatim with its type, which is what a method _builder_ wants.

## One set of rules, two sides

The kernel's headless core is server-safe on purpose, and that is the whole design:

- **In the browser, for UX.** `computeReadiness(fields, values)` decides whether the Run button is live. Nothing more — the browser's checks are trivially bypassed and are not a gate.
- **On the server, for trust.** A Server Action is a public endpoint. It runs the kernel's **`gateRunInputs(contract, data)`** against the same committed contract the browser co-rendered from: one call that combines the per-input schemas, repairs the data, validates it with ajv, re-applies the readiness rules over the contract's own schema, and builds the `{concept, content}` payload the run expects. The gate deliberately takes the **contract alone**, never the descriptor — a machine consumer must never need the presentation artifact to validate a payload — so its emptiness re-check walks the contract's `json_schema` for itself, and the kernel's gate-agreement suite proves that walk and the descriptor-mapped readiness answer together. `src/lib/runInputs.ts` is a thin shim over it — all that remains here is rendering the kernel's refusal (`missingInputs`, raw ajv `errors`) as the `bad_request` `PipelineError` this template's `<ErrorDisplay>` shows.

Because both sides get their rules from the same kernel, the hand-written guards on both sides are **deleted**, not kept as belt-and-braces. Two rules that can disagree is the failure mode this removes. An earlier version of this repo assembled the gate from the kernel's four exported steps itself; the kernel now owns that assembly precisely because the emptiness step is where assemblies go wrong — there are four look-alike predicates and only two of them are the ones the Run button reads (the near-miss pair, `inputMustBeFilled` + `isFilled`, agrees on every native concept and diverges on a structured one in both directions). The kernel's `docs/run-gate.md` tells that story in full.

The invariant to preserve is not "the two sides are identical" — they are not, and should not be — but "**the server side is a strict superset of the client side**". Readiness is UX; this is the gate. The kernel asserts the invariant in its own suite by running both sides over one table of structured fixtures, and `src/lib/runInputs.test.ts` re-asserts it over this repo's **committed contracts**: it drives a table of inputs through `computeReadiness` and through `gateRunInputs` and demands the same verdict, which is what would catch a method redesign reaching a shape the kernel's fixtures do not. A comment claiming the two agree is worth very little — two successive versions of this repo's gate shipped one that was wrong.

That table mixes synthetic contracts with the real `complex-form` one, deliberately. The synthetic rows isolate shapes no committed method has (a struct with required children, a half-filled struct); the real rows cover every state that method's form can actually reach, because a redesign of the method is the likeliest way to reintroduce a disagreement. Adding a method with a structured or plural input means adding its states there — that is the check that catches "the Run button was enabled and the run was rejected anyway".

The action's argument is therefore the schema-shaped data dict rather than a hand-typed `text: string`:

```ts
export async function runExtractEntitiesBlocking(data: Record<string, unknown>) {
  const gated = gateRunInputs(CONTRACT, data);
  if (!gated.ok) return gated; // a bad_request PipelineError, never a throw
  return executeBlockingRun(() => buildOptions(gated.inputs), parseEntities);
}
```

An invalid verdict becomes a structured error rather than an exception, for the same reason every other failure in this template does: Next.js strips a thrown Server Action error to an opaque digest in production builds. The mapping reads `missingInputs` first (it names the variables, which is nearly every real failure) and falls back to `errors` rendered through the kernel's `describeValidationError` — the scan can come up empty on a malformed value, and a rejection must never be undiagnosable. `describeValidationError` takes an injected translator so the kernel stays i18n-agnostic; this app has no i18n, so it supplies the English wording directly, typed on the kernel's key union so a new key fails the build rather than rendering `undefined`.

### What travels on the wire

Inputs go out in the runtime's **explicit envelope**, which is `apiInputsFromSchemaData`'s output:

```json
{ "text": { "concept": "native.Text", "content": { "text": "Apple announced…" } } }
```

Two special cases are the kernel's, and worth knowing before you "simplify" them: a blank **optional** (`?`) input is omitted entirely, so the runtime records a real absence rather than an empty string; and an empty **plural** (`[]`) input keeps its key but is sent **bare**, without the envelope, because the envelope bypasses the shaper that knows how to type an empty list.

### Two validators, on purpose

The dependency tree ends up with two: the kernel's **ajv** gates inputs, and the generated **zod** narrows outputs. That is coherent — each guards one direction of the wire — and it is not something to clean up.

## File inputs

The kernel never uploads. `DocumentField` fires `env.onDropFile(id, file)` and waits for the host to write a value back. This app's host is `useFileInputs`, and what it writes back is a file already in Pipelex storage:

```ts
const granted = await requestUpload({
  filename: file.name,
  content_type: file.type,
  size: file.size,
});
if (!granted.ok) return showError(granted.error);
const { uri } = await uploadWithGrant(granted.grant, file);
setValues((current) => setValueAtPath(current, id.split("."), { url: uri, filename: file.name }));
```

The `id` is a **dotted path**, not a name, which is what makes the same handler work for a file nested inside a structured concept or an item of a list. While the field's id sits in `env.uploadingIds`, the kernel shuts **every door into that value** — the dropzone, the "paste a URL instead" toggle and the URL input behind it — and shows a spinner. That guarantee is why this app needs no staleness token for a second selection while the first is still uploading, and why `PdfForm` passes plain run state as the form's `disabled`; the hook keeps the id there from the grant request until the reference is written, so there is no window between the two steps. The one write path `uploadingIds` cannot cover is the host's own chrome: the "Use sample PDF" shortcut writes into the same field — it fetches the sample and hands it to the same `dropFile` — so it disables itself while the field is resolving (`running || uploadingIds.size > 0`), the same rule, applied by the one who owns the button.

The kernel previews a file dropped into it from its own local copy, which it keeps after the upload. For a stored reference it holds no copy of — the sample's, or one pasted through "paste a URL instead" — it would ask the form's `env.resolveUrl`, and `PdfForm` passes none, so the preview settles on the kernel's placeholder. The method-app template resolves such a reference through a same-origin assets route, which this gallery has not taken.

### Why the file goes straight to storage

The first version of this seam encoded each file as a base64 `data:` URL in the browser and kept it in the form's value until Run, and the run's Server Action received every file of the form in one request, which `next.config.js` let reach 12 MB. The cap bounded one file, but nothing bounded a list, and no per-submission cap would have been right: a claim with fifteen receipts is a legitimate submission. An app made from the method-app template over a list of phone photos went past that limit, and the page could only say "Could not reach the server".

Now the bytes take the shortest path. The method's `request<Name>Upload` Server Action, which holds the API key, asks the platform for an **upload grant**: a presigned, create-only `PUT` for one new object, signed for the declared type and size, with the `pipelex-storage://` URI that object will carry. The browser, which holds the file and no key, sends it straight to storage with the SDK's `uploadWithGrant`, from the browser-safe `@pipelex/sdk/upload` entry. The bytes cross neither this app's server nor the API gateway, so neither the Server Action body limit nor the gateway's request quota caps a file below the platform's own limit, and a run carries references only, however many files a list holds. The body limit is back to Next's 1 MB default, which now bounds only a run's text and other typed values. `useRun` measures those before it calls the action and refuses a set past `MAX_RUN_INPUT_BYTES` (`src/lib/runRequest.ts`) with its size and the limit, because a body Next refuses would reach the page only as "Could not reach the server".

The grant writes one object, once, within minutes, and only the file it was requested for, which is what makes handing it to a browser safe. It is also a bearer capability, so nothing logs it. A file the user replaces or removes after dropping it stays in the organisation's storage, unreferenced.

**The grant route has to exist on the configured API.** A deployment without `POST /v1/upload/grant` answers `404`, which `classifyPipelineError` reports as `upload_unavailable`, naming the route and `PIPELEX_BASE_URL`, rather than letting it read as a transport failure. The hosted API serves the route: verified on 2026-09-24 against both `api.pipelex.com` and `api-dev.pipelex.com`, from the grant through the stored object's resolution.

### Where each check lives

The bundle can say the document input carries a `url`. It cannot say "a PDF, under 50 MB" — that is host policy. The checks are placed where the thing they check is:

- **The type and the size are the grant action's.** `checkUploadRequest` (`src/lib/fileInputs.ts`) reads the request as untrusted JSON and refuses a type outside the method's `ALLOWED_MIMES` and a size past `MAX_FILE_BYTES`, before any grant is asked for. `ALLOWED_MIMES` lives in a module of its own (`src/types/summarizePdfUploads.ts` for the PDF example), because the action's `"use server"` file may export only async functions and the form reads the list too. The grant then signs both, so storage refuses a file that differs from what was declared. `MAX_FILE_BYTES` is the platform's own limit, and the grant route's `413` for a larger declaration stays the authority behind it.
- **The form offers only what the grant action grants.** `PdfForm` passes `ALLOWED_MIMES` to `useRunInputs` as `allowedMimes`, and the hook narrows each file input to those formats with the kernel's `narrowFileFormats`. The dropzone's hint, its file picker's filter and its own check then name the same list, so a PNG dropped on the PDF input is refused at the dropzone rather than after the grant action has been asked. The form can offer only a format the kernel knows for the input's kind, and a list naming none of an input's formats is refused when the form renders.
- **The size check in the browser stays, as an early exit.** It reads the same exported constant, so it is not a second rule, and it only spares a round trip.
- **The type check in the browser is the kernel's, over the narrowed list.** The hint under the dropzone, its picker filter and the check a dropped file must pass all read the field's narrowed formats; the grant action's check is still the one that decides.
- **The empty-MIME normalization is available, because it was never a guard.** Some drag-drop sources and some Windows configurations report an empty `file.type` for a valid PDF, which the grant action then refuses as an unknown type. Re-wrapping the file before it is described is a description fix, and `useFileInputs` takes it as its `prepareFile` option. `PdfForm` passes `withPdfMime`, which re-wraps a `.pdf` with no type; a form written by `make add-method` passes none.
- **A failed upload is classified where it failed.** The grant request fails on the server, through `classifyPipelineError`. The upload itself fails in the browser, where the SDK's classes are thrown and `instanceof` holds, so `classifyUploadError` reads a storage refusal by its `code` (an expired or used grant, a file that no longer matches), and a transport failure by its `code` too: the upload's time limit, storage out of reach, a server error from storage, or storage giving up on the bytes. The time limit is the SDK's own, which grows with the file's size, so the hook passes no signal. Either way the error lands beside the field, before any run.

### The run action checks references

**A reference is not "nothing to verify", and the scheme check is the part that matters.** The kernel's file control also offers "paste a URL instead", so a run can arrive holding a string nobody uploaded. `prepareInputs` resolves any string it does not recognise as a `data:`, `http(s)://` or `pipelex-storage://` URL as a **local filesystem path** — it reads that path and uploads it (`@pipelex/sdk`'s `prepare-inputs.js` → `readLocalPath`). A Server Action is a public endpoint, so a gate that returns "fine" for an unfamiliar string hands an arbitrary server-side file read to any caller, with the contents coming back summarized. `checkFileInputs` therefore accepts a closed set and refuses by default: `pipelex-storage://`, what a dropped file becomes, and `https://`, what a pasted URL is. `http://` is deliberately outside that set, since nothing here needs a cleartext fetch, and so is `data:`: nothing in this app sends a file inline any more, and a run carrying bytes is exactly what outgrew the body limit.

The same function finds the files by walking the method's **wire descriptor**, not by reading the input values' shape and not by the literal name `document`. A gate that reads `inputs.document` silently stops applying the day the bundle renames that input — codegen carries the rename into the form, the readiness rules and the wire envelope, and the check just quietly disappears. Failing open on a routine edit is worse than not having the check. And a gate that looked for `url` keys in the values would get both directions wrong: a structured concept with a `url` field of its own is not a file, and a `Document` inside a list or two levels down a structured concept is. So `checkFileInputs` takes the pipe's `PipeInputFormDescriptor` (the action looks it up with `requireInputForm`, beside `requireContract`) and descends it the way the SDK's `prepareInputs` does — `document` / `image` is a file position at any depth, `object` descends its declared fields, `list` descends each item — reading a value only where the descriptor has promised a file. That is what makes a plural file input (`cvs: Document[]`) or a nested one ordinary rather than refused: the set of positions the gate verifies is, by construction, the set the SDK goes on to read. **`prepareInputs` accepts the gate's `{concept, content}` envelope as readily as a bare value**, and passes a stored reference through untouched.

## Styling

The kernel's controls are Tailwind classes over the standard shadcn semantic tokens, and its docs define two **mutually exclusive** host lanes. Pick by one question: _does the host run a Tailwind build?_

- **Compile lane (what this app uses).** Point your own build at the package's bundle and define the tokens in your own stylesheet.
- **Prebuilt lane.** Import `@pipelex/mthds-form/styles.css`. Only for a host with no Tailwind build — it carries Tailwind preflight, which would fight a Tailwind host's own.

**The compile lane requires Tailwind v4**, and that is a hard requirement rather than a recommendation. The controls are written in v4's vocabulary — `outline-hidden`, `aria-invalid:`, `data-placeholder:`, `wrap-break-word`, `field-sizing-content`, the `(--radix-…)` variable form — and a v3 build compiles those names to **nothing**: the controls render, and lose their focus, invalid and placeholder states without a word. This app moved to v4 for exactly that reason.

There is no `tailwind.config.ts` any more; v4 is configured in CSS, and everything below is in `src/app/globals.css`:

1. `@source "../../node_modules/@pipelex/mthds-form/dist/**/*.js"`. The controls ship compiled, so their class strings live in the package bundle, outside every tree Tailwind scans on its own. **Keep the `/**/\*.js`glob**:`dist`also carries sourcemaps, and Tailwind reads a`.map`as a source like any other file, so the bare directory quietly makes your stylesheet depend on a dependency's sourcemaps — comments inside`sourcesContent`and all. The directive sits after the whole run of`@import`s by convention; an `@source`between two imports was once seen to drop the imports that follow, but that did not reproduce on Tailwind 4.3.3 under Next/Turbopack,`@tailwindcss/cli` or raw PostCSS.
2. An `@theme inline` block mapping the shadcn token names, key for key with the kernel's own `src/styles/tailwind-entry.css` — that file is not a stylesheet to import, it is the token contract in executable form. Without the mapping, `bg-background`, `text-muted-foreground`, `border-input` and `rounded-md` are simply not utilities Tailwind knows. Two details there are load-bearing: `inline`, without which a token redefined lower in the tree (a `.dark` pane, a brand scope) would never move the utility; and the **bare `var()`** — since kernel 0.8.0 each token holds a whole colour, so the `hsl(var(--border))` wrapper of the v3 arrangement now yields `hsl(hsl(…))`, which the browser discards, leaving the element transparent.
3. `@import "tw-animate-css"`, for the select popover's and the tooltip's enter/exit utilities. It replaces the `tailwindcss-animate` plugin the JS config used to load, and the class names are the same.
4. A `@layer base` rule restoring `cursor: pointer` on enabled buttons. v4's preflight makes a button `cursor: default`; the kernel's own buttons carry no cursor class because under v3 a button was a pointer already.

The token _values_ come from `@pipelex/mthds-form/theme.css` (stock neutral shadcn variables, no preflight), imported in `src/app/layout.tsx` **before** `globals.css` so a host-level override wins on ordering. Restyling the forms is then a matter of overriding CSS variables. A host that already runs shadcn/ui under v4 has all of this except the `@source` line.

**The purge trap, because it is silent.** A missing `@source` does not fail the build. It produces a _mostly_-styled form — only the classes unique to the controls vanish (focus ring, placeholder color, textarea height, dropzone drag state), which reads as a broken design system rather than a missing line.

`src/app/globals.test.ts` is the gate, and it runs in `make test` like any other unit test. It compiles this stylesheet with the same plugin the app builds with, once as written and once with the `@source` lines stripped, and requires the first to carry a hundred-odd selectors the second does not. It also pins the two hazards that have no other check: that no token is re-wrapped in `hsl()`, and that every semantic token the controls use still resolves to a utility.

**Do not check this by grepping the bundle for a class name.** Tailwind v4 scans the whole repo, Markdown included, so every class name quoted in `CLAUDE.md`, `CHANGELOG.md` or this file — while explaining it — is minted into the bundle whether or not the kernel's own bundle was ever scanned. Measured on this repo: dropping the `@source` line takes the production stylesheet from 42,543 bytes to 23,222, and `grep -c 'field-sizing:content' .next/static/chunks/*.css` still answers `1` in both. The `(--radix-…)` variable form is no safer; this file quotes that too. Only the size of the difference is beyond prose's reach, which is what the test asserts.

To see the bytes by hand — the version the test automates:

```bash
# The temp entry must live beside the real one: `@import "tailwindcss"` and the
# relative `@source` path both resolve from the stylesheet's own directory.
grep -v '^@source' src/app/globals.css > src/app/_nosource.css
npx @tailwindcss/cli -i src/app/_nosource.css -o /tmp/without.css
npx @tailwindcss/cli -i src/app/globals.css   -o /tmp/with.css
rm src/app/_nosource.css
wc -l /tmp/without.css /tmp/with.css
```

`@tailwindcss/cli` is a devDependency for exactly this reason: it is a different package from the `@tailwindcss/postcss` plugin that builds the app, so without the entry those two lines would be an unpinned `npx` fetch off the network — grading the stylesheet with a compiler the app never runs.

`@custom-variant dark` is declared even though this app never sets a dark class: it costs nothing, and it is what a consumer who adds a dark theme would otherwise have to discover. Dark token values come with `theme.css` already.

## Adding an input to a method

Nothing in `src/` changes. Edit `methods/<name>/main.mthds`, run `npm run codegen`, commit the regenerated tree. The new input appears in the form with the right control, the right label, and the right gating; the server's gate starts requiring it; the tests that name it are the only place you touch.

`methods/complex-form/` is the worked demonstration: it is the one method here whose inputs go past a single text box, and `src/components/ComplexForm.tsx` is the payoff — no longer than `EntityForm.tsx`, and naming no input. Diff the two.

Two behaviour details of the current kernel worth knowing rather than debugging, both deliberate: a **required structured input must be touched** before Run lights up — a concept whose properties are all optional no longer reads ready while untouched, exactly as an untouched required number would not — and a **touched optional input enters the readiness count** (3 of 3 untouched, 3 of 4 once something is filled in it, 4 of 4 once complete), so the count a host displays moves when an optional structure is started.

The check that would catch a readiness-versus-gate regression is the agreement table in `src/lib/runInputs.test.ts`. A new method with a structured or plural input should add its states there before anything else.

**When the method lives elsewhere, the shape of this is identical.** A slice [`make add-method`](add-method.md) wrote for such a method — one whose source is a `methods/<name>/method.json` selector rather than a bundle in this repo — renders through exactly the same composition: `useRunInputs(CONTRACT, DESCRIPTOR)`, `<RunInputsForm>`, and `gateRunInputs` on the server, all reading the same committed `contracts.ts`. `src/components/TextStatsForm.tsx` is the scaffolded example, and reading it beside `EntityForm.tsx` is the point — the scaffold could write it precisely because there was nothing method-specific to write. The one difference is where you go to add an input: the method is not yours to edit here, so you change it where it lives (its repository, or [app.pipelex.com](https://app.pipelex.com) for a catalog method), point the manifest at the new version, and run `npm run codegen`.

## The result view: the same idea on the way out

A method's contract has two sides, and until recently only one of them was read. Each example hand-wrote a result component — three columns of entities, a title and a bulleted summary, an `<img>` with a download link — and a scaffolded slice got `<JsonResult>`, an honest JSON dump, because a component is a design decision about a shape and `make add-method` had never seen the shape. Both halves of that were the same gap: the method **declares** what it produces, and nothing was reading the declaration.

`POST /v1/validate` now answers with an `output_form` beside `input_form`, and the output contract carries a `json_schema`. `npm run codegen` asks for both views and commits `OUTPUT_FORM` in the same `contracts.ts`, so the result side needs no new artifact, no new gate and no new staleness check — `sources.json`'s `derived` hash already covered that file.

```tsx
const CONTRACT = requireContract(PIPE_IO_CONTRACTS, "summarize_pdf", "summarize_pdf");
const DESCRIPTOR = requireInputForm(INPUT_FORM, "summarize_pdf", "summarize_pdf");
const RESULT_FIELD = requireResultField(OUTPUT_FORM, CONTRACT, "summarize_pdf", "summarize_pdf");
// …
<RunResult field={RESULT_FIELD} value={state.output} name="document_summary" />;
```

**Both artifacts are required, and they answer different questions.** The descriptor says what the result IS — its kind, its nesting, whether it is plural, the authored order of a structure's fields. The contract's `output.json_schema` says what shape the payload arrives in and names the property it sits under: `TextContent {text}` for a `native.Text` result, the concept's own object for a structured one. A renderer holding one but not the other is back to inferring the missing half from the value, which is the guessing this whole pattern exists to remove. `requireResultField` reads the schema off the contract it is handed rather than looking it up again, so the pair cannot be mismatched.

Three consequences worth knowing:

- **Plurality is on the descriptor, never on the concept.** A `Concept[]` output is a `list` node whose `item` is the element; a renderer reads that and never touches the contract's `multiplicity`.
- **An `object` output is its own content model**, so nothing is unwrapped; every other kind's payload is a wrapper whose single property the schema names. The kernel gates that on the node's stated `kind`, never on the value's shape — otherwise a structured concept that happens to declare one field would be mistaken for a wrapper.
- **The narrowers in `src/types/` stay.** They are the trust boundary: the generated binder validates what came back, and the viewer renders what the binder validated. The result view deliberately does not re-validate — a runtime produced the output, and re-checking it client-side asserts distrust of the engine and buys nothing.

The `name` is app chrome, like the tab label. A result descriptor's root node is named `output` by the engine for every pipe there has ever been — correct in the artifact, since a pipe's output slot has no authored name, and wrong on screen, where the reader is looking at one data item. Written in the wire's snake_case, `presentation="app"` humanizes it exactly as it humanizes a field label, and it also names the file the viewer's download control writes.

**The result view does not re-read URLs either; the kernel judges them.** A run's output is model-shaped data crossing a trust boundary, and every URL the kernel acts on goes through its exported `viewableUrl` first, which admits `http(s):`, a same-origin path, `blob:` and a `data:` URL only for the raster image types and PDF, and returns the normalised string it judged, so the string a sink receives is the one that was checked. A document is framed only over `http(s):` or a path a host's resolver produced, never over a `data:` URL or a path the payload names, and an image in a text result's Markdown renders as a link unless the provider is given `proseImages="load"`. `src/components/RunResult.test.tsx` pins those refusals on a bare `<RunResult>`, which is what keeps a kernel release that loosens the gate, or an edit inside `<RunResult>` that loosens it, from passing unnoticed. A provider mounted above `<RunResult>`, in the layout say, is outside what those cases render, so a project that mounts one also renders it around `<RunResult>` in that test, as the method-app template does. **An HTML result is the one channel the gate does not cover.** The kernel renders a `native.Html` result's markup in a sandboxed frame that runs no script, but the frame's content policy admits `https:` images, so an `<img src="https://…">` in model-written markup is still fetched when the result paints, and neither `ResultEnvProvider` nor `StuffViewer` offers an option to narrow that. No method this gallery ships returns HTML; a project whose method does, and which cannot accept that, can set a page-level `Content-Security-Policy` with a narrower `img-src` in `next.config.js`, which the frame inherits, at the price of every remote image the kernel paints directly.

**A `pipelex-storage://` reference resolves nowhere in a browser**, and the kernel's seam for exchanging one is a `<ResultEnvProvider resolveUrl>` mounted above the result. This template mounts none, and that is not an oversight: the hosted runtime returns a signed `public_url` beside the storage URI and the kernel's file arms prefer it, so every file these examples produce paints unaided. A host whose runs return bare storage references adds one provider high in the tree — not a prop threaded through `<RunResult>`.

## What is deliberately not built

- **No client-side pre-validation with inline field errors.** The kernel supports it (`validateRunInputs` plus `describeValidationError` render per-field messages), and every demo method here has exactly one _required_ input, so readiness is the whole story. A form with several structured inputs would want it.
- **No custom URL resolution.** The kernel previews `http(s):`, `data:` and `blob:` URLs directly, and a dropped file from its own local copy, and asks the host's `resolveUrl` only for a value it cannot paint, which here is a `pipelex-storage://…/x.pdf` it holds no copy of: the sample PDF's, which is stored the way a drop is, or one pasted through the control's own "paste a URL instead". `PdfForm` passes no resolver, so the kernel settles on its placeholder. It used to pass one that handed the URI straight back, because kernel 0.10.0 spun forever over a stored reference with no resolver; 0.10.1 fixed that. Genuine resolution — exchanging that reference for a signed web URL — is not built, and a form seeded from a previous run would want it. Pinned by a regression test.

- **No storage-URL resolver on the result side.** `<ResultEnvProvider resolveUrl>` is the kernel's seam and nothing mounts it, because the hosted runtime sends a signed `public_url` beside every storage URI and the file arms prefer it. A host serving its own storage, or one restoring an old run whose signed URLs have expired, would want one — over the SDK's `resolveStorageUrl`, mounted once rather than per result.
- **No custom `FieldStrings`.** The kernel's English defaults are used verbatim. A localized host injects its own through `FieldStringsProvider`.
- **No eject.** Generating per-method form wiring the way `binder.ts` is generated is a real option later; the kernel adoption is what would make it cheap.
