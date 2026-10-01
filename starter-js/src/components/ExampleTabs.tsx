"use client";

import { useState } from "react";
import { ComplexForm } from "./ComplexForm";
import { EntityForm } from "./EntityForm";
import { PdfForm } from "./PdfForm";
import { ImageForm } from "./ImageForm";
import { TextStatsForm } from "./TextStatsForm";
// add-method:imports — `make add-method` inserts a scaffolded form's import
// directly above this line. Do not move it, reword it, or delete it; the
// scaffold refuses when it cannot find it, and a test pins that it is here.

/**
 * One entry per example, and the entry is the whole registration: the tab
 * button, the panel and the component all come from it.
 *
 * `make add-method` appends an entry at the anchor below, which is why the
 * panels are mapped rather than written out — a hand-written `<div
 * role="tabpanel">` per form would make a scaffolded tab a second insertion
 * point, and two anchors in two shapes is one more thing to keep in step.
 */
const TABS: { id: string; label: string; Component: () => React.JSX.Element }[] = [
  { id: "text", label: "Text entities", Component: EntityForm },
  { id: "pdf", label: "PDF summary", Component: PdfForm },
  { id: "image", label: "Image generation", Component: ImageForm },
  { id: "complex", label: "Complex inputs", Component: ComplexForm },
  { id: "text-stats", label: "Text stats", Component: TextStatsForm },
  // add-method:tabs — `make add-method` inserts a scaffolded tab's entry
  // directly above this line. Same rules as the import anchor above.
];

/**
 * Tab switcher for the example pipelines. Every panel stays mounted (toggled
 * with `hidden`) so an in-flight pipeline isn't aborted when the user switches
 * tabs to look at another example.
 */
export function ExampleTabs() {
  // The first entry is the default, so adding a tab never has to touch this
  // line and removing the first one cannot leave a dangling id behind.
  const [active, setActive] = useState<string>(TABS[0]!.id);

  return (
    // A column with `gap` rather than `space-y-*`: a `hidden` panel is out of the
    // flow entirely, so the gap does not depend on which tab is open. Under
    // Tailwind v4 `space-y-*` is `:where(& > :not(:last-child))`, which drops v3's
    // `:not([hidden])` guard and would give the active panel a trailing margin on
    // every tab but the last.
    <div className="flex flex-col gap-6">
      <div
        role="tablist"
        aria-label="Pipelex examples"
        className="flex flex-wrap gap-1 border-b border-slate-200"
      >
        {TABS.map((tab) => {
          const selected = tab.id === active;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`panel-${tab.id}`}
              onClick={() => setActive(tab.id)}
              className={
                selected
                  ? "border-b-2 border-slate-900 px-3 py-2 text-sm font-medium text-slate-900"
                  : "border-b-2 border-transparent px-3 py-2 text-sm font-medium text-slate-500 hover:text-slate-800"
              }
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {TABS.map(({ id, Component }) => (
        <div
          key={id}
          role="tabpanel"
          id={`panel-${id}`}
          aria-labelledby={`tab-${id}`}
          hidden={id !== active}
        >
          <Component />
        </div>
      ))}
    </div>
  );
}
