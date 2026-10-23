# The organization's branding

An app made from this template wears the branding of the organization its API key belongs to: the logo in a band across the top of the page, the organization's colours on the Run button, the tabs and the run status, and a "Made with Pipelex" credit at the end of the page. An admin sets the branding once, in the organization's settings on the Pipelex platform, and every app the team runs picks it up within a minute, with nothing to configure in the app.

## Branded or not

**An app is branded when its organization has set at least one logo or one colour**, in either colour set. The organization's name alone brands nothing, since every organization has one. An unbranded app renders no band, no colours of its own and no credit: its page is the template's page, with the Run button, the tabs and the run status in the form kernel's neutral colours.

**Branding never stops the app.** A read that fails, that the API refuses, that cannot even start because the client is misconfigured, or that takes longer than three seconds keeps the branding the last successful read returned, so a brief outage of the API changes nothing a person sees, and the logos stay served. When no read has succeeded yet, the page renders unbranded. Either way the server logs the reason once, with a line starting `[pipelex] branding not read,`, rather than on every page view, and tries again after fifteen seconds. A deployment whose API serves no branding, such as a self-hosted runner, therefore runs exactly as it did, with that one line in its log. With no `PIPELEX_API_KEY` configured, nothing is read at all.

## Where it comes from

`src/app/page.tsx` renders per request, never at build time, because the branding is read with the deployment's key, which a build does not have, and because a team that changes its logo should not need to redeploy. It reads the branding with `readOrganizationBranding` (`src/lib/brandingRead.ts`), which calls the SDK's `getBranding()` and keeps the answer in the server's memory for a minute, and a failure for fifteen seconds, so one read serves every page view in that window and concurrent views share the read in flight. A read that outlasts the three-second wait still lands: the page that stopped waiting rendered without it, and the next one wears the answer. Only the newest read may keep its answer, so a read given up on that settles after a newer one never overwrites it.

`brandingFromApi` (`src/lib/branding.ts`) turns the answer into what the page paints. It takes the answer as untrusted JSON and keeps only what it can use: a colour that is not `#rrggbb` counts as unset, and a logo whose description is incomplete (no `pipelex-storage://` reference, no digest, an unknown type or no positive size) is left out. The dark colour set is resolved colour by colour, each role taking its dark value and otherwise its light one.

## The colours

An organization sets up to three colours per theme: the button colour (`action`), an accent, and a header colour. None of them is painted as given. Each theme's three seeds go through the form kernel's `deriveBrandRoles`, against that theme's page colour, and the roles it answers are written onto the template's CSS variables by `brandStyleSheet` (`src/lib/brandStyle.ts`), as a `<style>` the page renders: the light set under `:root`, the dark set under `.dark`.

| Role              | Variable                   | Where it shows                                                                              |
| ----------------- | -------------------------- | ------------------------------------------------------------------------------------------- |
| The button colour | `--primary`                | The Run button and the kernel's primary controls                                            |
| Its text          | `--primary-foreground`     | Black or white, whichever reads on the button                                               |
| The accent's ink  | `--brand`                  | The selected tab's underline, the run status's spinner and border, the kernel's brand marks |
| The pale accent   | `--brand-muted`            | The run status's background, the kernel's selected pills                                    |
| The ink on it     | `--brand-muted-foreground` | The run status's text                                                                       |
| The header colour | `--app-header`             | The band behind the logo                                                                    |
| Its text          | `--app-header-foreground`  | The organization's name in the band, when no logo loads                                     |

**`--brand` is the accent's ink, never the raw accent.** The derivation darkens or lightens the accent until it reads as text on the page at 4.5:1, so an amber accent on the light page becomes a deeper amber, and anything painted with `text-brand` reads whatever accent the team picked. The same holds for every text variable on its background, in both themes, which `src/lib/brandStyle.test.ts` checks across a sweep of seeds. A branded team that set no button colour gets Pipelex green, and one that set no header colour gets the page itself as the band. The shadcn `--accent` variable is never touched: in the kernel's contract it is the neutral hover fill, not a brand colour.

Each variable falls back, in `src/app/globals.css`, to what an unbranded app shows, so the utilities that read them (`bg-brand-muted`, `border-brand`, `bg-app-header` and the rest) work on a page that defines none.

The two page colours, `#f8fafc` in light and the kernel's `#09090b` in dark, are declared twice on purpose: as `--page` in `globals.css`, which paints the page, and as `PAGE_COLORS` in `brandStyle.ts`, which the derivation measures against. A test holds the two to each other.

**The template sets no dark class itself.** A project that adds one, on `<html>`, gets the dark page, the dark colour set, and the band, the heading, the Run button, the tabs and the run status in dark. The panels under a finished or failed run (`RunDetails`, `CostReport`, `ErrorDisplay`) and the empty state are still light-only.

## The logo

The band tries the wide logo first, since it is the one drawn for a header, then the square one, then sets the organization's name as a one-line wordmark, or the app's own title when the organization's name is blank. A logo that fails to load falls to the next, so a broken image never shows. Its box is sized from the logo's recorded shape before the image arrives, so the band does not shift when it does. In the dark theme, when the organization has no header colour in either set, the band is the dark page and most logos are drawn for white, so the logo sits on a small white tile; with a header colour, it sits on that colour in both themes, undecorated.

**The browser never sees the logo's storage link.** Each logo is served from the app's own origin at `/api/branding/logo/<sha256>` (`src/app/api/branding/logo/[sha256]/route.ts`), named by the SHA-256 of its bytes. The route serves only the current logos of the key's organization and answers `404` for any other digest; it reads the bytes through the SDK's `fetchArtifact`, at most 1 MiB within fifteen seconds, checks them against the digest, and keeps them in the server's memory under it. A changed logo has a new digest and therefore a new URL, so the response is cached for a year as immutable, and a browser revalidating answers `304` against its tag. The type served is the one the platform read from the file's own bytes, never the store's, with `nosniff`, and an SVG is sandboxed by a content policy, as the assets route does for a document-capable type. A logo the route cannot fetch, or whose bytes do not match their digest, answers `502` with a code naming why, and the band falls back.

Like the assets route, the logo route is unauthenticated, which fits a single-tenant app: it shows anyone who can reach the app the logos the app already shows them, and nothing else.

## The credit

A branded app ends its page with "Made with Pipelex", a link to pipelex.com that opens in a new tab and says so to a screen reader. It is meta text in the page's muted colour, after the methods, never a fixed bar. An unbranded app shows none.

## Changing it in a project

The pieces are the project's own files once it is made, so a change is an edit: `src/components/AppPage.tsx` composes the page, `BrandBand.tsx` the band and `MadeWithPipelex.tsx` the credit. A project that wants none of it renders `<AppPage branding={null} />` in `src/app/page.tsx` in place of the read, which gives the unbranded page and calls nothing, and can then drop the `connection()` call so the page renders at build time again.

## Testing

`src/test/fixtures/branding.ts` holds an unbranded and a branded answer of `GET /v1/branding`, with two tiny logos whose digests are real, for the tests of the read (`brandingRead.test.ts`, mocking `@/lib/pipelexClient`), of the logo route (`route.test.ts`), of the derivation and the stylesheet (`branding.test.ts`, `brandStyle.test.ts`) and of the page (`AppPage.test.tsx`, `BrandBand.test.tsx`).
