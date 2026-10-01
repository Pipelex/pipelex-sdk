import type { Metadata } from "next";
import { HydrationMark } from "@/components/HydrationMark";
import { ResultEnv } from "@/components/ResultEnv";
import { SITE } from "@/site";
// The shadcn semantic tokens the form kernel's controls are written against —
// CSS variables only, no preflight, so it is safe beside this app's own Tailwind
// build. Imported first so anything in globals.css can override a token.
import "@pipelex/mthds-form/theme.css";
import "./globals.css";

export const metadata: Metadata = {
  title: SITE.title,
  description: SITE.description,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      {/* `ResultEnv` is the app's resolver for a run's stored files, mounted
          once above every method so each result view paints them through the
          assets route. See `src/components/ResultEnv.tsx`. */}
      <body className="antialiased">
        <ResultEnv>{children}</ResultEnv>
        {/* Sets `html[data-hydrated]` once the page is live, for a browser
            script to wait on. See `src/components/HydrationMark.tsx`. */}
        <HydrationMark />
      </body>
    </html>
  );
}
