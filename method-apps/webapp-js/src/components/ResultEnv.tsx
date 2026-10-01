"use client";

import { ResultEnvProvider } from "@pipelex/mthds-form/react";
import type { ReactNode } from "react";
import { resolveShareUrl } from "@/actions/shareUrl";
import { assetPath } from "@/lib/storageAsset";

/**
 * How this app turns a run's stored references into URLs — mounted once, in
 * the root layout, above every method's form and result view.
 *
 * The form kernel's file arms paint a `pipelex-storage://` reference only
 * through a host resolver, and this is that resolver, in the kernel's two
 * shapes: `assetPath` for DISPLAY, a pure rewrite onto `/api/assets/…` on this
 * origin that the route handler streams; `resolveShareUrl` for SHARING, a
 * Server Action that mints a presigned link per click. The two answer
 * different questions — a same-origin path is what keeps the credential off
 * the page and a picture from expiring while the tab is open, and it is
 * useless pasted elsewhere — which is why the kernel keeps them apart.
 *
 * One provider high in the tree, never a prop threaded through `<RunResult>`:
 * the kernel's `useResolvedUrl` reaches it from every file arm, in a gallery
 * tile or a table cell as readily as at the top level. Both functions are
 * module-level references, so the provider's memoized environment is stable
 * across renders. The prose-image policy stays at the kernel's default, which
 * does not load an image a model wrote into its prose until it is clicked.
 */
export function ResultEnv({ children }: { children: ReactNode }) {
  return (
    <ResultEnvProvider resolveUrl={assetPath} resolveShareUrl={resolveShareUrl}>
      {children}
    </ResultEnvProvider>
  );
}
