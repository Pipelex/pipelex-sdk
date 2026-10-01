"use client";

import { useEffect } from "react";

/** The attribute a browser script waits on: `html[data-hydrated]`. */
export const HYDRATED_ATTRIBUTE = "data-hydrated";

/**
 * Marks the page as hydrated, so a script driving it has something to wait on.
 *
 * Until React has hydrated the page, its controls are server-rendered markup
 * with no handlers attached. A script that acts in that window gets two kinds of
 * wrong answer. A file it sets never reaches the drop handler that uploads it.
 * And a Playwright screenshot, which hides the caret by writing
 * `caret-color: transparent` into the inline style of every input, rewrites an
 * attribute React then finds changed, so `next dev` reports a hydration
 * mismatch that no person's browser would ever see. Waiting for
 * `html[data-hydrated]` closes both.
 *
 * The mark is set on `<html>` rather than on a form because the template as
 * shipped renders an empty state with no form in it. It is exact for this app
 * as it stands: the whole page hydrates in the root's one commit, and this
 * effect runs after it. **A `loading.tsx`, a `<Suspense>` boundary or a
 * `dynamic()` import changes that**, because React hydrates each boundary on its
 * own, later: the mark would then be set before what is inside the boundary is
 * live, and an app that adds one should set its own mark inside the boundary.
 */
export function HydrationMark() {
  useEffect(() => {
    document.documentElement.setAttribute(HYDRATED_ATTRIBUTE, "");
  }, []);
  return null;
}
