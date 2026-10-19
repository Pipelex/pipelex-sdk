# The run timeline: a durable run's progress, live

Under every tab's form, a durable run draws its own progress while it runs: one row per pipe invocation the run has reached, nested under the controller that ran it, each with a bar on a shared time axis that grows while the invocation runs. A sequence shows its steps in order, a batch its items (a wide batch starts collapsed into its one row, with a toggle), a condition the outcome it took, and a call the platform tried again its attempts. A header above the rows says how the run stands and how far it has got, in the platform's own one-line summary. The drawing is `RunTimeline` from [`@pipelex/mthds-ui`](https://www.npmjs.com/package/@pipelex/mthds-ui), and the data is the hosted progress snapshot `@pipelex/sdk` reads with `getRunProgress`.

The timeline appears once the run has reached its first invocation, stays under the result once the run is done, and shows where a failed run stopped. A new submit starts it afresh. A run in Blocking mode has no id until it has ended, so it is never followed, and its tab shows what it showed before the timeline existed: the status card while it runs, then the result or the error. The "Check claims" tab is the demo for it: its method splits a text into claims, checks each one in a batch, then a condition picks how to word the verdict, so its timeline has nesting, items and an outcome to draw, where every other tab's method is a single pipe and draws one row.

## Two layers, one seam

The timeline is built so another app can lift it whole, keeping the view and replacing only where the snapshots come from. The line between the two is a reader function.

**The view** knows nothing of the hosted API, and it is made of these files:

| File                                 | What it does                                                                                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/lib/progressReader.ts`          | Declares the seam, the `ProgressRead` and `ProgressReader` types, and nothing else.                                                                          |
| `src/hooks/useRunProgress.ts`        | Follows one run (below): takes its id, whether it is still going, and a reader, and returns the fresher of every snapshot it has read, or `null` while none. |
| `src/components/RunTimelineView.tsx` | Draws one snapshot: `RunTimeline`, loaded lazily, inside a render boundary of its own, in the gallery's colours. It takes `snapshot` and `live` and no more. |

```ts
export type ProgressRead =
  | { kind: "snapshot"; snapshot: ProgressSnapshot } // the run's progress at one moment
  | { kind: "none" } // no progress for this run yet: read again
  | { kind: "unavailable" } // this source will not serve this run's progress: stop asking for this run
  | { kind: "failed" }; // this read failed: keep what is held, and read again
export type ProgressReader = (runId: string, signal: AbortSignal) => Promise<ProgressRead>;
```

**These files import React, `@pipelex/mthds-ui/timeline`, `@pipelex/mthds-ui/timeline/react` and each other, and nothing else**, and ESLint holds them to it: an override in `eslint.config.mjs` refuses every other import with `no-restricted-imports`, so `make check` fails at the offending line. It is an allowlist rather than a list of what to refuse, because a module of this app such as `@/lib/errors` imports the SDK itself, and a denylist naming only `@pipelex/sdk`, the actions and `next/*` would let it in by the back door. The freshness rule the hook keeps by, `fresherSnapshot`, comes from the view's own dependency for the same reason; it is the same rule as the SDK's `isFresherRunProgress`.

**The source** is this app's own, and it is the part another app replaces:

| File                                         | What it does                                                                                                                                 |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/app/api/runs/[runId]/progress/route.ts` | `GET /api/runs/{runId}/progress`: reads the snapshot on the server with this app's client, so the API key never reaches the browser.         |
| `src/lib/runProgress.ts`                     | `toProgressSnapshot`: the mapping from the SDK's `RunProgress` to the timeline's `ProgressSnapshot`, and the redaction (below). Server-only. |
| `src/lib/fetchRunProgress.ts`                | The browser's reader: fetches the route and turns its answer into a `ProgressRead`, never throwing.                                          |

**The gallery's glue** is `src/components/RunProgressPanel.tsx`, which every form renders with one line, `<RunProgressPanel state={state} />`, last in its column in every phase, so the timeline never jumps between the status card and the result. It follows the run its form saw running with an id, keeps that run's snapshot through the `done` and `error` phases, and renders `RunTimelineView` alone, with no wrapper of its own: the timeline's own "Run progress" region is the one landmark it adds, and nothing at all is in the page while it draws nothing. `make add-method` emits the same line in every form it writes.

## How the route answers

The route calls `getRunProgress(runId, { signal: request.signal })`, handing the SDK the request's own signal, so a browser that stops reading, because the run it follows changed or its page went, cancels the upstream read too. It answers with a `200` whose JSON body is discriminated on `state`, except where reading again may help:

| What the SDK did                                                                                                                                                                                                                                                                                                                                                                                         | The route's answer                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Returned the snapshot.                                                                                                                                                                                                                                                                                                                                                                                   | `200 { "state": "snapshot", "snapshot": … }`, as `toProgressSnapshot` made it. |
| Threw an `ApiResponseError` with status `404`: a run the platform's index has not caught up with yet, a moment after its start.                                                                                                                                                                                                                                                                          | `200 { "state": "none" }`                                                      |
| Threw a refusal reading again cannot change: one whose verdict (`errorVerdictOf`) is not retryable and lays the failure on the request or the configuration (`input` or `config`). A bare runner without the route is the SDK's `RunLifecycleUnavailableError`, and a hosted gateway answers a path it does not route with `403`, as it answers a key it refuses, so the two cannot be told apart there. | `200 { "state": "unavailable" }`                                               |
| Rethrew the browser's own abort, the request's signal having fired. The route checks that signal before it reads the failure, so whatever the abort threw is never classified, and never taken for a final refusal.                                                                                                                                                                                      | `502` with an empty body, which nobody reads.                                  |
| Anything else: a failure the SDK judges retryable (a gateway `5xx`, a rate limit, an unreachable API), a `runtime` fault in one answer, such as a `200` the SDK could not read, or an error carrying no verdict.                                                                                                                                                                                         | `502` with an empty body.                                                      |

Every answer carries `Cache-Control: no-store`, and the route sets `dynamic = "force-dynamic"`, since a working run's progress moves from one read to the next. It logs nothing, following this app's rule against diagnostic console writes: the status poll is where a failing API shows itself. A fault in the mapping itself is this app's bug, not a failed read, so it is left to Next.js, which answers `500` and reports it.

**A Route Handler, not a Server Action.** Next.js runs a client's Server Actions one at a time, so a progress action would queue behind the status poll and the form's own actions, such as an upload grant, and they behind it. A `GET` route runs beside them.

**It adds no exposure.** The route reads any run of the key's organization by its id, exactly as each method's `poll<Name>Run` action already does, which is one reason the servers listen on loopback by default ([`CLAUDE.md`](../CLAUDE.md), "The servers listen on loopback by default"). It spends nothing, and it sends no CORS headers, so another origin cannot read its answer.

## Where the timeline draws today

**The hosted dev plane serves the progress route, and production does not yet.** Against `https://api.pipelex.com`, the default base URL, production's gateway answers the route with `403`, so the first read answers `unavailable`, the gallery stops reading that run, and every tab shows exactly what it showed before the timeline existed. To see it today, point `PIPELEX_BASE_URL` at `https://api-dev.pipelex.com` in `.env.local`, with a key that plane accepts, and run the "Check claims" tab in Durable mode. Once production serves the route, the timeline draws there with no change to this app.

## How a run is followed

`useRunProgress({ runId, going, read })` follows one run by these rules:

- **While the run goes**, it reads at once, then again `PROGRESS_POLL_MS` after each answer, which is the status poll's base interval. Two reads of one run are never in flight together.
- **It keeps the fresher snapshot**, by `fresherSnapshot`: never one saying the run is pending or running over one saying it has ended, otherwise the higher `version`, and at the same version the later `assembled_at`. Reads that overlap can answer out of order, so it never simply takes the latest answer. An answer about another run is dropped, and a read still on its way when the followed run changes or the component unmounts is aborted through its signal.
- **A snapshot saying the run has ended stops the poll**, even while the host still says the run is going, since an ended run does not resume; the host's own end then starts the final reads.
- **Once the host says the run is no longer going**, it makes the final reads, at most `FINAL_PROGRESS_READS`, `FINAL_PROGRESS_READ_GAP_MS` apart, even when the snapshot it holds already says the run ended. A read can lag behind the end the status poll saw, and the platform contract lets a read project an ended run from fewer events than a later read will, so the snapshot held may not be the last one. The reads stop early once one answers an ended snapshot that leaves the held one unchanged, or `unavailable`. A read already on its way is awaited rather than doubled.
- **`none` reads again** at the same pace, **`unavailable` stops reading** for that run, final reads included, and **`failed` keeps the held snapshot** and reads again.
- **It is never a gate on the run.** It surfaces no error: the timeline is an addition to the run's status, the status poll alone decides how a run ends, and no failure to read progress ever reaches the person.
- **Its life is bounded by the run's.** It reads only while its host says the run is going, plus the final reads, so `useRun`'s own ceiling bounds it too. It does not pause while the page is hidden, because the status poll does not either; a project that wants both to pause changes both.

## What leaves the server

What a host shows of a run is the host's choice, so the mapping is this app's policy, applied on the server in `toProgressSnapshot`, and it asks nothing of the SDK or of the timeline:

- **Every member is picked, never spread**, at every level, so a member a later platform adds does not reach the browser unread.
- **An invocation's failure text never leaves the server.** Each `last_failure.message` is replaced with one fixed sentence, "An attempt at this step failed.", which is true also of a step that recovered, because a snapshot carries no flag saying whether that text was written for the caller, and a platform run with verbose error disclosure would pass a provider's raw text. The run's own failure is still shown in full, from its report, by `<ErrorDisplay>`.
- **A degradation is worded from its reason**, never from the platform's `message`, which under verbose disclosure appends the worker's own failure text. A reason this app does not know gets a sentence that never says the run is fine, and the members the SDK types as optional and the timeline as present arrive as `null` when absent.

This is the rule a run's failure report already follows here, "the provider's raw text never reaches the person" ([`docs/errors.md`](errors.md)), applied to the snapshot. In the browser, `fetchRunProgress` reads the route's answer member by member in plain TypeScript rather than with a schema library, so zod stays out of the browser's bundle, and reads anything that does not check out as `failed`.

## How it is drawn

- **Lazily.** `RunTimelineView` loads `@pipelex/mthds-ui/timeline/react` with `React.lazy` the first time it has a snapshot to draw, so a page that never follows a durable run never downloads it. The timeline ships as its own chunk, its stylesheet included, and no graph library from the package reaches the page.
- **Inside its own boundary.** A small class component catches a snapshot the timeline cannot draw and draws nothing in its place, so it takes down only the timeline, never the form, the result or the error. A new snapshot is tried afresh.
- **In the gallery's colours.** It passes `theme="light"`, since the gallery has no dark mode, and a `paletteColors` map from the timeline's surface, border, text and font tokens onto the variables the form kernel's tokens already declare in `src/app/globals.css`. The status colours stay the timeline's own, because the kernel declares no success or warning colour. The timeline's entry imports its own stylesheet and uses no utility classes, so Tailwind needs no `@source` for it.
- **Live from its host.** It passes `live` as the host knows it, so running bars stop growing as soon as the status poll sees the run end, before the final snapshot arrives.
- **Quiet.** The view adds no live region of its own: `<RunStatus>` stays the run's announcer, since a timeline announced on every repaint would drown a screen reader. The timeline itself announces its one-line summary, politely, when it changes, and shows a degradation as a `role="status"` notice, with no prop to turn either off.

## Testing it

- **Unit tests** cover each file of both layers, co-located as `*.test.ts(x)`: the mapping, the route (with `@/lib/pipelexClient` mocked and `getRunProgress` among its methods), the reader, the hook on fake timers, the view, and the panel. The forms' tests fake the reader, so no test fetches anything. The snapshots they read are the hand-written fixtures of a "Check claims" run in `src/test/fixtures/runProgress.ts`.
- **Vitest inlines `@pipelex/mthds-ui`** (`server: { deps: { inline: ["@pipelex/mthds-ui"] } }` in `vitest.config.mts`). Vitest hands a dependency to Node unchanged, and the timeline's entry imports its own stylesheet, which Node cannot load, so every test that draws the timeline would fail on the import. Inlined, Vite transforms the package as it does this app's own files, stylesheet included. Keep the setting while the timeline is in the tree.
- **The live proof** is `e2e/run-timeline.spec.ts`. It runs the "Check claims" demo in Durable mode and asserts that the timeline shows a row while the run goes, keeps its rows once the result shows, and draws the batch's items. It skips without a key, like the other live specs, and skips unless the base URL serves the progress route, which it finds out before spending anything: where the route is served, a run id no run has is the platform's `404`, and anything else, production's `403` or a bare runner's `RunLifecycleUnavailableError`, means it is not.

## Lifting the view into another app

The view is a handful of files and one dependency, and the one thing to write is a reader.

1. Add `@pipelex/mthds-ui` to the app's dependencies, and inline it in Vitest's `server.deps` if the app tests with Vitest.
2. Copy `src/lib/progressReader.ts`, `src/hooks/useRunProgress.ts` and `src/components/RunTimelineView.tsx`, and the ESLint override that holds them to their imports. Change `GALLERY_PALETTE` and `theme` in `RunTimelineView.tsx` to the app's own tokens.
3. Write a `ProgressReader`: given a run id and an abort signal, it reads that run's progress from wherever the app keeps it and answers a `ProgressRead`, never throwing. Its snapshot must be a `ProgressSnapshot`, the type `@pipelex/mthds-ui/timeline` exports; reading it on a server the app controls, as this app does, is where to keep a key and to decide what the browser may see.
4. Render it where the run is shown:

```tsx
const snapshot = useRunProgress({ runId, going, read: myReader });
return <RunTimelineView snapshot={snapshot} live={going} />;
```

`runId` is the run to follow, or `null` for none, and `going` is whether the app knows the run is still going; the hook reads while it is, makes the final reads once it is not, and stops for a run whose reader answered `unavailable`.

**A source that pushes snapshots needs no hook at all.** When snapshots arrive on their own, from a stream or a socket rather than a read the app makes, hand `RunTimelineView` each one as it arrives: `RunTimeline` keeps the fresher of the snapshot it holds and the one it is handed, by the same rule, so a push source needs no follow logic. The view serves both kinds of source without choosing between them.
