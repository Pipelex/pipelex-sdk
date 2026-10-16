# Chrome lineage: where this gallery's shared code comes from

This repository is the gallery: an app that presents several demo methods as tabs. The method-app family, [`method-apps/`](https://github.com/Pipelex/pipelex-sdk/tree/main/method-apps) in `Pipelex/pipelex-sdk`, holds the demo-free template that was extracted from it, `webapp-js/`, which is the app `/pipelex-scaffold` creates for one method. The two share the code every method needs, which this document calls the chrome. **The template holds the reference copy of the chrome, and this gallery keeps a copy by hand.** No tool keeps the two in sync.

## The rule

- **A chrome fix lands in the template first.** It then reaches this gallery as a port, made deliberately, with the gallery's own differences (below) kept.
- **Before fixing the chrome here, look at the template.** If the template already carries the fix, port it rather than writing a second one, so that the two copies stay easy to compare.
- **A chrome fix made here first needs its twin in the template.** A defect is often found in the gallery, because the gallery has the most methods to exercise the chrome. Fix it here if that is where you are, and make sure the template receives the same fix, so that the next scaffolded app does not ship the defect.

The template's [`method-apps/webapp-js/docs/chrome-lineage.md`](https://github.com/Pipelex/pipelex-sdk/blob/main/method-apps/webapp-js/docs/chrome-lineage.md) is the detailed account from the other side: the commit the extraction started from, and each file it carried unchanged, adapted or left behind.

## What the chrome is

- **The run chrome**: `src/hooks/` (`useRun`, `useRunInputs`, `useFileInputs`), the run helpers in `src/lib/` (`blockingRun`, `durableRun`, `wireOutput`, `errors`, `serverEnv`, `runInputs`, `runRequest`, `resultField`, `fileInputs`, `uploadGrant`, `usageReport`, `loadBundle`, `pipelexClient`), the shared components (`RunInputsForm`, `RunResult`, `RunStatus`, `RunDetails`, `ModeToggle`, `CostReport`, `ErrorDisplay`, `HydrationMark`), `src/types/pipelineError.ts` and `src/config.ts`, with their tests, and the `HydrationMark` mount in `src/app/layout.tsx`.
- **The codegen kit**: everything under `scripts/`, including the `make add-method` scaffold and its tests and fixtures.
- **The configuration**: the `Makefile`'s gestures and argument handling, `next.config.js`, `tsconfig*.json`, `vitest.config.mts`, and the ESLint, Prettier and Playwright configurations.

Everything else is the gallery's own: the demo methods under `methods/`, their generated trees, their actions, adapters and forms, `ExampleTabs`, the page, and the e2e specs that drive the demos.

## Where the gallery differs on purpose

These differences follow from the gallery having demos, and a port keeps them:

- **The registry.** The gallery's tabs are the `TABS` array in `src/components/ExampleTabs.tsx`, which lists the demos and carries the two `add-method:` anchors. The template registers methods in `src/methods.ts` and renders them with `MethodPage`. The scaffold writes the same entry into either file, importing the form as `./<Name>Form` here and as `@/components/<Name>Form` there.
- **The app's identity.** The gallery's title and description are written in `src/app/page.tsx` and `src/app/layout.tsx`. The template reads them from `src/site.ts`.
- **Demo-specific error handling.** The image demo keeps the `bad_image_output` kind, `BadImageOutputError` and the web-renderable URL check in `parseGeneratedImage`, and some error messages name a demo file to check or call the app "the starter" where the template's say "this app".
- **The execution-mode switch.** The gallery teaches both execution modes, and its live e2e shows the blocking cap by switching one tab to Blocking, so every form keeps its `<ModeToggle>`, `src/config.ts` keeps `DEFAULT_EXECUTION_MODE`, the timeout errors keep hinting "Switch this example to Durable mode", and the scaffold keeps emitting the switch. The template removed all of this for an end user's page, and reads the mode from `NEXT_PUBLIC_EXECUTION_MODE` alone as `EXECUTION_MODE`. Decided on 2026-09-24, when the rest of that change was carried here.
- **The demo's own file seam.** `PdfForm` passes `useFileInputs` a `prepareFile` that re-wraps a `.pdf` the browser described with no type, and its "Use sample PDF" shortcut stores the sample through the same `dropFile` as a drop.
- **The run timeline, until the template receives its port.** The gallery draws a durable run's live progress, and the template does not yet: the view (`src/lib/progressReader.ts`, `src/hooks/useRunProgress.ts`, `src/components/RunTimelineView.tsx`), its source (`src/app/api/runs/[runId]/progress/route.ts`, `src/lib/runProgress.ts`, `src/lib/fetchRunProgress.ts`), the gallery's glue `src/components/RunProgressPanel.tsx`, their tests and `src/test/fixtures/runProgress.ts`, the `@pipelex/mthds-ui` dependency, the ESLint override that holds the view to its imports and the `server.deps.inline` setting in `vitest.config.mts` are gallery-only. So is one line of the codegen kit: the scaffold in `scripts/lib/add-method.mts` emits `<RunProgressPanel state={state} />` last in every form it writes, with its import, and its tests expect it. The port belongs to the method-app family, which copies the view's files whole and adds the line to its own scaffold ([`docs/run-timeline.md`](run-timeline.md) says what lifting the view takes); once it lands, this entry goes and the timeline is chrome like the rest.

Any other difference between the two copies is a port that has not been made yet. Compare the two files to find it, and carry the change in the direction the rule gives.
