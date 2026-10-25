import { BrandBand } from "@/components/BrandBand";
import { MadeWithPipelex } from "@/components/MadeWithPipelex";
import { MethodPage } from "@/components/MethodPage";
import { brandStyleSheet } from "@/lib/brandStyle";
import type { AppBranding } from "@/lib/branding";
import { SITE } from "@/site";

interface AppPageProps {
  /** The organization's branding, or `null` for an unbranded app. */
  branding: AppBranding | null;
}

/**
 * The app's one page: the app's heading and its methods, worn in the
 * organization's brand when it has one.
 *
 * A branded app — one whose organization set at least one logo or colour —
 * renders three things more, and an unbranded one renders exactly as before:
 *
 * - **its colours**, when it set any, as a `<style>` setting the tokens the
 *   controls read on the document's root, so a popover portalled to `<body>`
 *   wears them too: the light set under `:root` and the dark one under
 *   `.dark` (`src/lib/brandStyle.ts`), each holding only the tokens the
 *   team's colours produce, so the template's own stay for the rest;
 * - **its band** across the top, with the logo (`BrandBand`);
 * - **the "Made with Pipelex" credit** at the end of the page (`MadeWithPipelex`).
 *
 * The page heading stays the app's own title, below the band.
 */
export function AppPage({ branding }: AppPageProps) {
  const sheet = branding !== null ? brandStyleSheet(branding) : "";
  return (
    <>
      {sheet !== "" && (
        // The sheet's values are hex colours derived on the server, which
        // `brandStyleSheet` checks one by one, never text from the API.
        <style dangerouslySetInnerHTML={{ __html: sheet }} />
      )}
      {branding !== null && (
        <BrandBand
          orgName={branding.orgName}
          logos={branding.logos}
          tileInDark={branding.tileInDark}
        />
      )}
      <main
        className={
          branding !== null ? "mx-auto max-w-2xl px-6 pt-10 pb-16" : "mx-auto max-w-2xl px-6 py-16"
        }
      >
        <header className="mb-8">
          <h1 className="text-3xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">
            {SITE.title}
          </h1>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">{SITE.description}</p>
        </header>
        <MethodPage />
        {branding !== null && <MadeWithPipelex />}
      </main>
    </>
  );
}
