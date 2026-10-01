"use client";

import { useState } from "react";
import { isFilled, type RunField } from "@pipelex/mthds-form";
import {
  FieldPresentationProvider,
  FieldRenderer,
  OptionalToggle,
  type FieldEnv,
} from "@pipelex/mthds-form/react";

interface RunInputsFormProps {
  /** The method's input descriptors, from `useRunInputs`. */
  fields: RunField[];
  values: Record<string, unknown>;
  onValuesChange: React.Dispatch<React.SetStateAction<Record<string, unknown>>>;
  disabled?: boolean;
  /**
   * Ambient state the kernel threads down to every control. A file input asks
   * its host to upload via `env.onDropFile`; see `PdfForm`.
   */
  env?: FieldEnv;
}

/**
 * The one kernel composition in this app: `RunField` descriptors rendered
 * through `FieldRenderer`, which dispatches each to its control.
 *
 * There is no per-method branching anywhere — a text input, a PDF dropzone and
 * a date picker all arrive the same way, from the contract `npm run codegen`
 * committed beside the method. `presentation="app"` is the kernel's own seam for
 * a use-facing surface: humanized labels, no concept pills (`native.Text` is
 * implementation detail to somebody filling in a form).
 */
export function RunInputsForm({
  fields,
  values,
  onValuesChange,
  disabled = false,
  env,
}: RunInputsFormProps) {
  const [showOptional, setShowOptional] = useState(false);

  // Optional inputs that are still empty stay folded away, so the form *opens*
  // at its simplest shape. Required — or already seeded — inputs always show.
  //
  // Decided once, at mount, which is what "opens at" means: recomputing it from
  // the live value each render makes a control disappear out from under the
  // person using it. Clear the last character of a seeded optional input while
  // the optional section is collapsed and the field becomes foldable, drops out
  // of `visibleFields`, unmounts mid-edit and drops focus to `<body>`. No method
  // in `methods/` has an optional input, so nothing here reaches it — but this
  // is the template's one kernel composition and adopters inherit it verbatim.
  const emptyOptionals = () =>
    new Set(fields.filter((f) => !f.required && !isFilled(values[f.name])).map((f) => f.name));
  const [foldable, setFoldable] = useState(emptyOptionals);

  // Re-decided on the way *back* to collapsed, and only there. A field the user
  // has since filled stops being foldable, so collapsing hides the still-empty
  // ones and leaves the filled one on screen — rather than pulling a filled
  // control off the page while its value stays on the wire, behind a toggle
  // that now says "1 optional input" as though it were empty. Recomputing at
  // this moment costs nothing the freeze was protecting: a collapsed field is
  // not being edited, so there is no caret to drop.
  const toggleOptional = () => {
    if (showOptional) setFoldable(emptyOptionals());
    setShowOptional((expanded) => !expanded);
  };
  const isFoldable = (field: RunField) => foldable.has(field.name);
  const foldableCount = fields.filter(isFoldable).length;
  const visibleFields = showOptional ? fields : fields.filter((field) => !isFoldable(field));

  return (
    <FieldPresentationProvider presentation="app">
      <div className="space-y-6">
        {visibleFields.map((field) => (
          <FieldRenderer
            key={field.name}
            field={field}
            value={values[field.name]}
            onChange={(value) => onValuesChange((current) => ({ ...current, [field.name]: value }))}
            // The id is a dotted path: label linkage and upload tracking key on it.
            id={field.name}
            env={{ ...env, disabled }}
          />
        ))}

        {foldableCount > 0 && (
          <OptionalToggle
            count={foldableCount}
            expanded={showOptional}
            onToggle={toggleOptional}
            noun="input"
          />
        )}
      </div>
    </FieldPresentationProvider>
  );
}
