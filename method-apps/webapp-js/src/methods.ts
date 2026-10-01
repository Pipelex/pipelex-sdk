import type { ComponentType } from "react";
// add-method:imports — `make add-method` inserts a scaffolded form's import
// directly above this line. Do not move it, reword it, or delete it; the
// scaffold refuses when it cannot find it, and a test pins that it is here.

/** One method the app runs: its form and result view, and how to name it. */
export interface RegisteredMethod {
  /** The method's directory name under `methods/`, which is also its tab id. */
  id: string;
  /** The tab label, shown only when the app runs several methods. */
  label: string;
  /** The method's form and result view, scaffolded by `make add-method`. */
  Component: ComponentType;
}

/**
 * The methods this app runs, one entry each, and the entry is the whole
 * registration: `<MethodPage>` renders the page, and the tabs when there are
 * several, from this array alone.
 *
 * `make add-method` appends an entry at the anchor below, which is why nothing
 * else in the app names a method: a second place to register one would be a
 * second insertion point, and two anchors in two shapes is one more thing to
 * keep in step.
 */
export const METHODS: RegisteredMethod[] = [
  // add-method:tabs — `make add-method` inserts a scaffolded method's entry
  // directly above this line. Same rules as the import anchor above.
];
