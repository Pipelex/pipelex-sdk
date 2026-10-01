"use client";

import { useState } from "react";
import { METHODS, type RegisteredMethod } from "@/methods";

interface MethodPageProps {
  /** The registry to render. Defaults to the app's own; tests pass their own. */
  methods?: readonly RegisteredMethod[];
}

/**
 * The app's page body, rendered from the method registry in `src/methods.ts`.
 *
 * - No method registered: an empty state naming the gesture that adds one.
 * - One method: its form and result view are the page. There is no tab bar and
 *   no label, because the page heading already names the app.
 * - Two or more: a tab per method, the first selected.
 */
export function MethodPage({ methods = METHODS }: MethodPageProps) {
  const [only] = methods;
  if (only === undefined) return <EmptyState />;
  if (methods.length === 1) return <only.Component />;
  return <MethodTabs methods={methods} />;
}

function EmptyState() {
  return (
    <section
      aria-labelledby="no-method-title"
      className="rounded-lg border border-dashed border-slate-300 bg-white p-6"
    >
      <h2 id="no-method-title" className="text-base font-medium text-slate-900">
        No method yet
      </h2>
      <p className="mt-2 text-sm text-slate-600">
        This app renders the methods registered in{" "}
        <code className="rounded bg-slate-200 px-1.5 py-0.5 text-xs">src/methods.ts</code>, and none
        is. Add one from your shell, then reload this page:
      </p>
      <pre className="mt-3 overflow-x-auto rounded bg-slate-900 px-3 py-2 text-xs text-slate-100">
        <code>make add-method METHOD=&lt;your method&gt;</code>
      </pre>
      <p className="mt-3 text-sm text-slate-600">
        <code className="rounded bg-slate-200 px-1.5 py-0.5 text-xs">docs/add-method.md</code> lists
        the forms a method can take.
      </p>
    </section>
  );
}

/**
 * A tab per method. Every panel stays mounted (toggled with `hidden`), so a run
 * in flight is not aborted when the user switches to another method.
 */
function MethodTabs({ methods }: { methods: readonly RegisteredMethod[] }) {
  // The first entry is the default, so adding a method never has to touch this
  // line and removing the first one cannot leave a dangling id behind.
  const [active, setActive] = useState<string>(methods[0]!.id);

  return (
    // A column with `gap` rather than `space-y-*`: a `hidden` panel is out of the
    // flow entirely, so the gap does not depend on which tab is open. Under
    // Tailwind v4 `space-y-*` is `:where(& > :not(:last-child))`, which drops v3's
    // `:not([hidden])` guard and would give the active panel a trailing margin on
    // every tab but the last.
    <div className="flex flex-col gap-6">
      <div
        role="tablist"
        aria-label="Methods"
        className="flex flex-wrap gap-1 border-b border-slate-200"
      >
        {methods.map((method) => {
          const selected = method.id === active;
          return (
            <button
              key={method.id}
              type="button"
              role="tab"
              id={`tab-${method.id}`}
              aria-selected={selected}
              aria-controls={`panel-${method.id}`}
              onClick={() => setActive(method.id)}
              className={
                selected
                  ? "border-b-2 border-slate-900 px-3 py-2 text-sm font-medium text-slate-900"
                  : "border-b-2 border-transparent px-3 py-2 text-sm font-medium text-slate-500 hover:text-slate-800"
              }
            >
              {method.label}
            </button>
          );
        })}
      </div>

      {methods.map(({ id, Component }) => (
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
