"use client";

import type { RunField } from "@pipelex/mthds-form";
import {
  FieldPresentationProvider,
  humanizeFieldName,
  StuffViewer,
} from "@pipelex/mthds-form/react";

interface RunResultProps {
  /** The method's result descriptor, from `requireResultField`. */
  field: RunField;
  /** The narrowed output — already validated by the method's generated binder. */
  value: unknown;
  /**
   * What this data item is called — the panel's header, the section's accessible
   * name, and the base name of the file the download control writes.
   *
   * App chrome, like the tab label: the descriptor's own name is the engine's
   * `output` for every pipe there has ever been, which is right in the artifact
   * (a pipe's output slot has no authored name) and wrong on screen, where the
   * reader is looking at one data item. Written in the wire's snake_case so
   * `presentation="app"` humanizes it the way it humanizes every field label —
   * `document_summary` reads as "Document summary".
   */
  name: string;
}

/**
 * The one kernel composition on the output side — `<RunInputsForm>`'s twin.
 *
 * The result is rendered from the method's own contract, exactly as the form
 * above it is: `OUTPUT_FORM` says what the output IS (its kind, its nesting,
 * whether it is plural) and the contract's `output.json_schema` says what shape
 * the payload arrives in, and `requireResultField` pairs them into the single
 * `RunField` handed here. Nothing in this component knows what
 * `extract_entities` produces, and nothing inspects the value to decide how to
 * lay it out — swap the method, re-run codegen, and the view follows.
 *
 * `StuffViewer` gives the two views a result actually needs: **Rendered**, the
 * descriptor-driven view for a person, and **JSON**, the verbatim receipt for
 * whoever is debugging the pipe. `presentation="app"` is the same seam
 * `<RunInputsForm>` uses and must stay in step with it: humanized labels and no
 * concept pills, because a result and the form that produced it show the same
 * fields and must read the same way.
 *
 * **It does not re-read URLs either, so the payload reaches `StuffViewer`
 * untouched.** The kernel judges every URL it acts on through its exported
 * `viewableUrl`, frames a document only over `http(s):` or a path this app's
 * resolver produced, and renders an image in a text result's Markdown as a link
 * instead of loading it. `ResultEnv.test.tsx` pins that at this composition.
 * An HTML result's markup is the exception: it is framed under a content policy
 * that admits `https:` images, so a remote image in it loads on paint
 * (`docs/input-form.md` says what a project can do about that).
 *
 * **A stored file paints through this app's own assets route.** A run's file
 * comes back as a `pipelex-storage://` reference, which resolves nowhere in a
 * browser, beside a signed `public_url` that expires in minutes and IS the
 * credential to the object. The kernel's seam for exchanging the reference is
 * `<ResultEnvProvider resolveUrl>`, and `src/components/ResultEnv.tsx` mounts it
 * once in the root layout, above this: `assetPath` rewrites the reference onto
 * `/api/assets/…`, which `src/app/api/assets/[...path]/route.ts` streams through
 * the SDK's `fetchArtifact` on the server. The kernel asks that resolver before
 * it reads `public_url`, so the signed link is never what the browser fetches and a
 * picture cannot expire while the tab is open. The copy-URL control goes the
 * other way, through `resolveShareUrl`, a Server Action minting a fresh
 * presigned link per click — a same-origin path is useless on a clipboard.
 * Nothing about that is threaded through here, which is the point of a
 * provider high in the tree.
 */
export function RunResult({ field, value, name }: RunResultProps) {
  return (
    // A labelled region rather than a bare wrapper: the kernel's header is a
    // styled span, not a heading, so without this the result is a stretch of
    // content a screen reader cannot jump to or name. One per screen — a hidden
    // tab panel is out of the accessibility tree, so the tabs cannot collide.
    <section aria-label={humanizeFieldName(name)}>
      <FieldPresentationProvider presentation="app">
        <StuffViewer field={field} value={value} name={name} />
      </FieldPresentationProvider>
    </section>
  );
}
