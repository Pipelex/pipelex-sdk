# Reading a run's results

A completed run hands back one object, `RunResults` (`src/runs.ts`), and every field of it is described here. The same object comes back from `startAndWaitForResult`, from `waitForResult(runId)`, and from the `completed` arm of `getRunResult(runId)` — one accessor set whichever path ran, which is the point of the type.

Two paths produce it. Against the hosted API the SDK starts a durable run and polls `GET /v1/runs/{id}/results`, where the platform relays the run's S3 artifacts verbatim. Against a bare `pipelex-api` runner, which has no run store, the SDK falls back to the blocking `POST /v1/execute` and maps the runner's native `pipe_output` onto the same shape, lifting the artifacts that ride it onto their own fields. `startAndWaitForResult` picks between the two from the `GET /v1/version` handshake, so a consumer does not choose.

**Calling the blocking route yourself.** `execute()` returns a `PipelexExecuteResult` rather than a `RunResults`, because that object is the runner's whole typed envelope and nothing of it is thrown away. To read such a result through this page's fields, lift it: `resultsFromExecute(result)` (`src/execute-result.ts`) is the same mapping `startAndWaitForResult` applies on its fallback, exposed for the caller who drives `execute()` directly. It is pure — no client, no network — and what it buys is everything written against `RunResults`: `summarizeUsage`, `downloadArtifacts`, the graph pair and the three I/O artifacts, instead of re-reading `pipe_output` by hand.

```ts
import { resultsFromExecute, summarizeUsage } from "@pipelex/sdk";

const executeResult = await client.execute({
  pipe_code: "my_domain.my_pipe",
  contents: { "my_domain.mthds": source },
});
const results = resultsFromExecute(executeResult);
console.log(results.main_stuff, summarizeUsage(results).total_cost_usd);
```

| field | type | hosted (durable) path | bare-runner (blocking) path |
|---|---|---|---|
| `pipeline_run_id` | `string` | the run store's id | the runner's own id for the call |
| `main_stuff` | `unknown` (optional) | the `main_stuff.json` artifact | resolved out of the returned working memory |
| `working_memory` | `DictWorkingMemory \| null` | the `working_memory.json` artifact | lifted off `pipe_output` |
| `graph_spec` | `unknown` | the `graphspec.json` artifact | lifted off `pipe_output` |
| `graph_assembly_error` | `string \| null \| undefined` | absent until the platform relays it | lifted off `pipe_output` |
| `pipe_io_contracts` | `PipeIOContracts \| null \| undefined` | the `pipe_io_contracts.json` artifact, once relayed | lifted off `pipe_output` |
| `input_form` | `InputForm \| null \| undefined` | the `input_form.json` artifact, once relayed | lifted off `pipe_output` |
| `output_form` | `OutputForm \| null \| undefined` | the `output_form.json` artifact, once relayed | lifted off `pipe_output` |
| `pipe_io_artifacts_error` | `string \| null \| undefined` | absent until the platform relays it | lifted off `pipe_output` |
| `tokens_usages` | `TokensUsageRecord[] \| null` | the `tokens_usages.json` artifact | lifted off `pipe_output` |
| `usage_assembly_error` | `string \| null` | relayed | lifted off `pipe_output` |
| `pipe_output` | `DictPipeOutput \| null \| undefined` | absent | the runner's whole native output |

## Reading only some artifacts — `artifacts`

A results read on the hosted path fetches every artifact from storage and re-signs every link inside them, which is wasted work for a caller that wants one of them, such as a history view showing a run's output or a usage panel. `getRunResult(runId, { artifacts })` narrows the read: the SDK sends the names as one comma-separated `?artifacts=` parameter and the platform reads, re-signs and returns only those. The names are `RUN_RESULT_ARTIFACTS` — `graph_spec`, `pipe_io_contracts`, `input_form`, `output_form`, `main_stuff`, `working_memory` and `tokens_usages` — typed as `RunResultArtifact`, and `tokens_usages` brings `usage_assembly_error` with it. Without the option every artifact is read.

```ts
const state = await client.getRunResult(runId, { artifacts: ["main_stuff", "tokens_usages"] });
const results = await client.waitForResult(runId, { artifacts: ["working_memory"] });
```

**Absent versus null.** With a selection, an artifact the caller did not name is absent from the result, reading `undefined`, while one it named that the run never wrote is `null`. So `undefined` means "not asked for" and `null` means "asked for, not there". That is also why `main_stuff` is declared optional: it is never null on a completed run, but it is absent from a read that left it out, and `MissingMainStuffError` is thrown only by a read that asked for it — one with no selection, or one naming `main_stuff`.

An empty selection or a name outside the list is a `RequestArgumentError` thrown before any request, `input` and not retryable, the same refusal the platform would answer with a `400`. `waitForResult` and `startAndWaitForResult` take the same `artifacts` in their poll options and send it on every poll; `startAndWaitForResult` refuses a bad selection before it starts the run. Against a bare runner the selection has nothing to narrow: the blocking fallback returns every artifact the runner sent. `downloadArtifacts` given a `run_id` asks for its scope's artifact alone.

## `pipeline_run_id` — the durable handle

The run id is what makes a run readable after the process that started it has gone. `start` returns it in its acknowledgement before the run finishes, and every lifecycle read takes it: `getRunStatus(runId)` for the status row, `getRunResult(runId)` for a single result lookup, `waitForResult(runId)` to resume polling a run an earlier session started. It is also what a `RunTimeoutError` leaves you with — the run keeps executing server-side, so the timeout is a reason to re-poll by id, not a reason to run the method again.

```ts
const ack = await client.start({ pipe_code: "my_domain.summarize", inputs: { text: "..." } });
console.log(ack.pipeline_run_id); // persist this — it outlives the process

// …later, in another process
const results = await client.waitForResult(ack.pipeline_run_id);
```

Against a bare runner the id identifies the call the runner just answered, but there is no run store behind it: the lifecycle routes are absent, so re-reading it raises `RunLifecycleUnavailableError`. Durable resumption is a hosted capability.

**Holding the id while `startAndWaitForResult` waits.** `startAndWaitForResult` returns only the result, so a caller that waits through it would otherwise learn the run's id only once the run is over. Its second argument, `StartAndWaitForResultOptions`, takes the wait's options plus `onStarted`, called once with the start acknowledgement as soon as the durable run exists and before the first poll: the moment to show the id, log it, or keep it for an interrupt, since a caller that stops waiting (its `signal` aborted, a `RunTimeoutError`) leaves the run going on the server and resumes it with `waitForResult(id)`.

```ts
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
const results = await client.startAndWaitForResult(
  { method_ref: "github.com/acme/methods/receipt-review@v1.0.0", inputs },
  {
    signal: controller.signal,
    onStarted: (ack) => console.error(`Run started: ${ack.pipeline_run_id}`),
  },
);
```

It is never called on the blocking path, a bare runner's `POST /v1/execute` or the fallback to it, which has no run id to give before it answers. The acknowledgement is handed over whole, a `method_ref` run's `method_provenance` and a `method_id` run's `method_version` (the version the run runs, a number or `"draft"`) included. The callback runs synchronously and its return value is ignored; an exception it throws propagates out of `startAndWaitForResult` before anything is polled, and the run it was told about keeps going.

**An abort before the run exists creates none.** The `signal` is read before the run is started as well as during the wait: a caller that aborts while the `GET /v1/version` handshake is in flight gets its abort, and neither `POST /v1/start` nor the blocking `POST /v1/execute` is sent; nor is the execute when the abort lands while a runner that looked hosted refuses the start. The same holds while the method's tree is prepared: the signal is handed to the directory's listing, each file's read, the blob route and each upload of a missing blob, so an abort stops the one under way and no run is started ([method-trees.md](./method-trees.md#how-a-tree-travels)). The tree is prepared once, before the start, so a fallback to the blocking execute sends the files the start sent, reading and uploading none of them again. Once the start or the execute is sent, the abort stops only the wait, and a started run goes on, by its id.

**Knowing whether a run may exist.** `onStarting`, the other callback `StartAndWaitForResultOptions` takes, is called right before each request that may create a run is sent: `POST /v1/start`, and the blocking `POST /v1/execute` of a bare runner or of the fallback to it, so it is called twice when a runner that looked hosted refuses the start. Until it is called no run exists, and once the `signal` has aborted it is not called and no such request is sent, so a caller that stops waiting before then can say that no run was started; from then until `onStarted`, a run may exist that the API has not yet named. It runs synchronously and its return value is ignored; an exception it throws propagates before the request is sent. The `pipelex-sdk` command words its interrupt message by it ([`cli.md`](cli.md)).

**A failed start says whether a run may exist.** An error from the start, or from the blocking execute, carries `runMayHaveStarted`: `true` when the request may have created a run although the call failed, so a person looks the run up in the run history before starting it again, and then its `retryable` is `false` ([`errors.md`](errors.md#a-failed-run-start--runmayhavestarted)). Once `onStarted` has been called the run exists and the caller holds its id, so an error while the composite waits started nothing: its `runMayHaveStarted` is `false`, and its `retryable` is about waiting again on that id with `waitForResult`, never about calling `startAndWaitForResult` again, which would start a second run.

## A degraded status — `degraded` and `degradation`

`getRunStatus(runId)` reads a run's status row, which is how a caller shows a run while it runs. It returns a `RunRead` (`src/runs.ts`): the run record plus `degraded`, `degradation`, `request_id` and `retry_after_seconds`, the last parsed from the `Retry-After` header.

**`degraded` means the read is not a plain fresh reading, and `degradation.reason` says why.** So `degraded` alone no longer means the run is fine; branch on the reason.

| `reason` | What holds | `status` | What to tell the person |
|---|---|---|---|
| `status_unavailable` | The platform could not reach the workflow engine. | The last one recorded. | Nothing about the run, which may be fine: the status is not fresh, and the next read comes after `retry_after_seconds`. |
| `workflow_task_failing` | The workflow task that drives the run has failed `failed_attempts` times in a row since `failing_since`, so the run is not making progress. | Live. | The run is stuck. The workflow engine keeps retrying, and if the task is still failing at `ends_at` the platform ends the run `FAILED`, with a `WorkflowTaskKeptFailingError` report ([errors.md](./errors.md#a-failed-run--runerrorreport)). |

```ts
const run = await client.getRunStatus(runId);
if (run.degraded) {
  // A platform older than the degradation sends none; `degraded` then meant only this.
  const reason = run.degradation?.reason ?? "status_unavailable";
  if (reason === "workflow_task_failing") {
    const ends = run.degradation?.ends_at ?? "its time limit";
    console.warn(`The run is stuck (${run.degradation?.failed_attempts} failures in a row); it ends at ${ends}.`);
  } else if (reason === "status_unavailable") {
    console.warn(`The status is not fresh; reading again in ${run.retry_after_seconds ?? 5}s.`);
  } else {
    console.warn(`The status read is degraded (${reason}).`); // a reason this SDK does not know yet
  }
}
```

- **`failing_since` and `ends_at` are `null` when the platform could not find the recorded failure** in the workflow's history. It then does not end the run itself, and the run's own time limit ends it `TIMED_OUT`, with a `RunTimedOutError` report. Both are always `null` for `status_unavailable`, and so is `failed_attempts`.
- **`message` is the platform's sentence.** For `workflow_task_failing` it says how many attempts have failed in a row, that the run is not making progress and when the platform will end it. It does not quote the worker's own failure text, which only a platform run locally with `ERROR_DISCLOSURE=verbose` adds, so a product surface may show it; `failed_attempts` and `ends_at` carry the same facts as fields. Never branch on its wording.
- **`reason` is read open**, typed `DegradationReason | (string & {})`: a reason a later platform adds arrives as its raw string rather than failing the read, and a consumer that does not know it should not tell the person the run is fine.
- **The degradation is checked field by field, so it never fails the poll.** A `degradation` that is not an object, or whose `reason` is not a string, reads as `null`, since it cannot be branched on; `message`, `failing_since` and `ends_at` are kept when they are strings and `failed_attempts` when it is an integer, `null` kept for each, and absent otherwise; members this SDK does not name are relayed as sent. `degradation` is `null` whenever `degraded` is false, and absent on a platform that predates it. `degraded` is left as the server sent it.
- **`request_id` is the id of the request that started the run**, the one to quote to support beside the run id. `getRunDetail` carries it too; it is `null` for a run saved before the platform recorded it.

**The results read carries no degradation, and the wait needs none.** `waitForResult` and `startAndWaitForResult` poll the results route, whose in-flight answer is a `202` with no body. That route settles the run the same way the status read does, so a waiter receives a stuck run's end as a `RunFailedError` carrying the `WorkflowTaskKeptFailingError` report within one poll of `ends_at`. A caller that wants to show the degradation while it waits passes `onProgress`, whose snapshot carries the status read's `degradation` and places it on the invocation it concerns (see the next section), or reads `getRunStatus` beside the wait.

Both SDKs read a status body the same way, held to it by a case file they share, `tests/fixtures/run-status-reads.json`.

## Following a run while it runs — `onProgress` and `getRunProgress`

A run's **progress snapshot** says how far the run has got while it goes on: which invocations of which pipes have started, ended or been skipped, how many items of each batch are done, which outcome each condition took, and where the run is retrying or stuck, with a one-line `summary` to show as it is. The hosted API serves it on `GET /v1/runs/{id}/progress`, projecting it at each read from the run's live progress events, its status and what its workflow engine reports of its health. Progress belongs to the hosted plane, part of neither the MTHDS Protocol nor the runner's API, so a bare runner serves none. The type is `RunProgress` (`src/runs.ts`).

**While waiting: `onProgress`.** `waitForResult` and `startAndWaitForResult` take `onProgress` beside `onPoll`, called with each snapshot the wait reads that is fresher than the last one it delivered:

```ts
const results = await client.waitForResult(runId, {
  onProgress: (progress) => console.error(progress.summary),
  // e.g. "Running summarize_filing_batch (step 3 of 4): 1 of 3 items done, 2 running"
});
```

- **It reads on each poll that finds the run still running**, after the results read and before `onPoll`, at the wait's own cadence. Without `onProgress` the wait makes no progress request at all.
- **It delivers only a fresher snapshot.** Two reads can answer out of order, so the wait keeps the last snapshot it delivered and calls `onProgress` only with one that is fresher by `isFresherRunProgress` (below): a snapshot that repeats the last one, or that a lagging read projected from fewer events, is not delivered, and a snapshot of the run ended is never followed by one showing it still going.
- **A progress read never fails the wait.** The results read is the truth about the run, so a progress read that fails, whatever the reason — a network failure, a `503` from the platform while it cannot read the run's events, an answer the SDK cannot read — skips that poll's snapshot, and the next poll reads again. A server answering that it has no progress route at all, a hosted API older than it, is not asked again during that wait. The caller's `signal` still ends the wait with its abort.
- **It stops when the run ends.** Once the results read finds the run ended, the wait returns the results or throws `RunFailedError` without reading the progress again, so the last snapshot delivered may still show the run going. A caller that wants the final snapshot, to draw the finished timeline or to show where a failed run stopped, reads `getRunProgress(runId)` once more.
- **`startAndWaitForResult` honours it on the durable path only.** Its blocking fallback, a bare runner's `POST /v1/execute`, has no run to read, so `onProgress` is never called there.
- **The callback runs synchronously** and its return value is ignored. An exception it throws propagates out of the wait, as one thrown by `onPoll` does, and the run keeps going on the server.

**Reading it yourself: `getRunProgress(runId)`.** It returns the snapshot as the platform answered it, the `RunProgress`. A pending run, and a run that has written no progress event yet, answer with no invocation. When the workflow engine cannot be reached the read still answers `200`: its `degradation` reads `status_unavailable`, its `status` is the last one recorded and no invocation carries a health annotation. A run that does not exist, or belongs to another organization, is the platform's `404`, an `ApiResponseError`, and a server without the route, a bare runner or a hosted API older than it, is a `RunLifecycleUnavailableError`. The members the freshness rule and a timeline lean on are checked: an answer whose `version` is not a non-negative integer, whose `pipeline_run_id`, `mode`, `status`, `assembled_at` or `summary` is not a string, whose `invocations` is not a list, or one of whose invocations misses its path, pipe identity, status or times, is an `ApiResponseError` for an answer the SDK cannot read. The snapshot's `degradation` and each invocation's are checked field by field as the status read's are, and one whose `reason` is not a string is dropped, so neither fails the read. Members the SDK does not name are relayed as sent.

### The snapshot

Every timestamp is RFC 3339 in UTC written with `Z`, with fractional seconds when the source recorded them. A required member is always present, `null` where its row says so, and an optional one is absent when it does not apply, never `null`.

| member | type | what it says |
|---|---|---|
| `pipeline_run_id` | `string` | The run. |
| `mode` | `"live" \| "dry"` | The mode of the events it was projected from; always `live` on the hosted route. |
| `status` | `RunProgressStatus` | `pending`, `running`, `succeeded`, `failed` or `canceled`. The platform maps `PENDING` to `pending`, `RUNNING` and `STARTED` to `running`, `COMPLETED` to `succeeded`, `FAILED` and `TIMED_OUT` to `failed`, and `CANCELLED` and `TERMINATED` to `canceled`. |
| `version` | `number` | The number of distinct progress events it was projected from, superseded attempts' included, so it never decreases while the run's events are kept; what two snapshots are compared by. |
| `assembled_at` | `string` | When it was projected, which a running invocation's elapsed time is measured against when the reader cannot trust its own clock. |
| `summary` | `string` | One line saying how far the run has got, such as `Running summarize_filing_batch (step 3 of 4): 1 of 3 items done, 2 running; not progressing at summarize_filing (step 3 of 4, item 3 of 3) after 4 failed attempts`. Show it as it is; never parse it. |
| `degradation` | `RunDegradation`, optional | The run status's `degradation`, whole, present when the run reads degraded ([above](#a-degraded-status--degraded-and-degradation)). |
| `invocations` | `ProgressInvocation[]` | Every invocation the snapshot knows, each before its descendants, the children of one invocation in the order of their numbers. |
| `root_path`, `chain` | optional | Absent on a snapshot of the whole run, which is every snapshot the hosted API serves. |

An **invocation** is one run of one pipe inside the run, named by its `path`: the entry pipe's `pipe_ref`, then one segment per controller level — `step_<n>`, `branch_<n>`, `item_<n>`, `outcome_<key>` or `default` — joined by `/`, so `filings.review_filings/step_3/item_2/step_1` is the first step of the sequence that the batch at step 3 runs for its second item. The path names one invocation in every view of a run, a retried one included, and is what nests a timeline's rows.

| member | type | what it says |
|---|---|---|
| `path` | `string` | Its path. |
| `pipe_code`, `pipe_ref`, `pipe_type` | `string` | The pipe it runs: its bare code, which a timeline labels its row with, its `pipe_ref`, and its type as the method declares it, such as `PipeLLM`, an open string. |
| `status` | `ProgressInvocationStatus` | `scheduled` (an item of a batch that has fanned out and not started), `running`, `succeeded`, `failed`, `skipped` (a successful end with no output of its own) or `canceled` (not ended when the run ended), each about its latest attempt. |
| `started_at`, `ended_at` | `string \| null` | Its latest attempt's start and end; `null` while it has not started or not ended, and `ended_at` `null` when it is `canceled`. |
| `step_count`, `branch_count` | `number`, optional | On a `PipeSequence`, the number of steps its author wrote; on a `PipeParallel`, the number of its branches. |
| `skip_reason` | `string`, optional | On a `skipped` invocation, why. |
| `batch` | `ProgressBatch`, optional | On a `PipeBatch` that has fanned out, `{ total, done, running, failed }`: `done` counts the items succeeded or skipped, and an item scheduled or canceled is in none of the three. |
| `condition` | `ProgressCondition`, optional | On a `PipeCondition` that has resolved, `{ selected_outcome }`, the key its value matched, or `null` for its default outcome. |
| `attempts` | `number`, optional | Health: how many times its work has been tried, present only when more than once. |
| `last_failure` | `ProgressFailure`, optional | Health: `{ message, at? }`, the latest failure of its work. `message` keeps the disclosure of a run's error report: the failure's own text only when it was written for the caller, `An internal error occurred.` otherwise. |
| `degradation` | `RunDegradation`, optional | Health: the run is stuck here, in the run status's own words — the status read's `degradation`, `workflow_task_failing`, placed on the run's root or on the batch item whose execution keeps failing to advance. |

The health annotations are what the workflow engine reports, so an absent one means that nothing was observed, never that the engine looked and found all well. They reuse the run status's `RunDegradation` rather than a shape of their own, so the code that shows a degraded status shows a stuck invocation too.

### Keeping the fresher of two — `isFresherRunProgress`

`isFresherRunProgress(read, held)` says whether a snapshot just read should replace the one held, by the platform's rule, its first clause before the other two:

1. A snapshot of the run still going (`pending` or `running`) never replaces one of the run ended (`succeeded`, `failed` or `canceled`), whatever their versions, and one of the run ended always replaces one of it going: an ended run does not resume, and a read lagging behind the writes can project the ended run from fewer events than an earlier read projected it running from.
2. Otherwise the higher `version` is fresher.
3. At the same version the later `assembled_at` is, compared as instants rather than as text, since the platform writes microseconds only when it has them. A read projected before a timeout ended the run can arrive after one projected once it had, with no event between them.

Nothing held means anything read is fresher, and two snapshots equally fresh keep the one held. `onProgress` delivers by it; a caller holding snapshots from more than one source keeps the fresher by it too. The platform also nudges a browser over its WebSocket with a `run_progress_update` frame carrying only the version the route has reached: a client reads `getRunProgress` when a frame's version is higher than the one it holds, keeps the fresher of the two by this rule, reads the route again whenever its socket opens since a frame sent while it was closed is lost, and reads it on a `run_status_update` too, since a run's end can change the snapshot with no new event. An API-key caller, whom the WebSocket does not accept, polls the route, which is what `onProgress` does.

```ts
import { isFresherRunProgress, type RunProgress } from "@pipelex/sdk";

let held: RunProgress | undefined;
async function refresh(runId: string): Promise<void> {
  const read = await client.getRunProgress(runId);
  if (isFresherRunProgress(read, held)) {
    held = read;
    render(held);
  }
}
```

## `main_stuff` — the output

`main_stuff` is the resolved content of the run's main output and is always present for a completed run, unless the read's `artifacts` selection left it out. On the hosted path it is the `main_stuff.json` artifact; on the blocking path the SDK resolves it out of the returned working memory through the response's `main_stuff_name`. Both deliver the same content shape, so there is no shape-guessing and no path-dependent branch to write. A completed run that cannot deliver one throws `MissingMainStuffError` rather than handing back a half-filled result.

It is typed `unknown` because the content is polymorphic: a structured output arrives as an object of the concept's fields, and a multiple output as the envelope `{ items: [...] }` that the runtime's `ListContent` serialises to. Every content type serialises to an object, natives included — a text output is `{ "text": "…" }` and a number `{ "number": 0 }` — so a guard written for a bare `""` or `0` never fires, and an empty multiple output is `{ "items": [] }` rather than `[]`. Narrow it where you read it, ideally through the types generated for the method rather than a hand-written cast.

For a multiple output that means reading `items` off the object and mapping the generated per-concept parser over its members, because codegen emits a parser per concept and no wrapper type for the envelope. **Do not rely on the parser to catch the mistake for you.** The generated schemas are not strict, so a concept with a required field rejects the envelope loudly, while one whose fields are all optional parses it to `{}` and discards the output in silence.

**An integer past `Number.MAX_SAFE_INTEGER` reads as a `bigint`.** The results are read with `parseExactJson`, on both paths, so such an integer anywhere in them, in `main_stuff`, `working_memory` or `graph_spec`, holds its exact digits, and an output passed back to `start` goes back as the run produced it. `JSON.stringify` throws on a `bigint`, so code showing the results as JSON text writes them with `stringifyExactJson` ([exact-integers.md](./exact-integers.md)).

```ts
const state = await client.getRunResult(runId);

switch (state.state) {
  case "completed": {
    // `state.result` is the RunResults; `main_stuff` is the output content.
    const summary = state.result.main_stuff as { title: string; bullets: string[] };
    console.log(summary.title, summary.bullets.length);
    break;
  }
  case "running":
    console.log(`not finished — poll again in ${state.retry_after_seconds ?? 2}s`);
    break;
  case "failed":
    // `message` already names the reason; `error` is the run's stored report, or null.
    console.error(`run ended as ${state.status}: ${state.message}`);
    if (state.error?.user_action) console.error(`next step: ${state.error.user_action.detail}`);
    break;
}
```

`getRunResult` is the single-shot lookup and returns that discriminated state. `waitForResult(runId)` drives the same lookup in a loop, honouring the server's `Retry-After`, and returns the `RunResults` directly — throwing `RunFailedError` on a terminal non-completed status and `RunTimeoutError` when the budget runs out. The `failed` arm and `RunFailedError` carry the same facts: the run's `status`, the `message` naming the reason, and `error`, the run's stored error report, typed as `RunErrorReport` and `null` when the run ended without one. [`errors.md`](./errors.md#a-failed-run--runerrorreport) describes the report field by field.

## `working_memory` — every named stuff of the run

`working_memory` is the run's whole working memory: every named stuff the run held when it finished, as `{ root, aliases }`. `root` maps each stuff's name to the stuff itself — its concept ref, a string such as `native.Text`, and its content — and `aliases` maps further names onto root keys. It holds the inputs the run was given and the intermediates it produced as well as the main output, which is what a consumer needs to show what went into a run beside what came out, or to repopulate the inputs of a run it restores.

It reads the same on both paths. On the hosted path it is the `working_memory.json` artifact, relayed verbatim; on the blocking path the SDK lifts it off `pipe_output`. On the hosted path it is `null` when the artifact had not been written when the results were delivered. On the blocking path it is always there, because the SDK resolves `main_stuff` out of it and a response without one throws `MissingMainStuffError` first.

`main_stuff` is one of its entries — the content of the stuff the run names as its main output — already resolved. Read `main_stuff` for the output and `working_memory` for everything else; there is no need to find the main output in the working memory by hand. The type, `DictWorkingMemory`, mirrors the MTHDS standard's `DictWorkingMemory` field for field.

```ts
for (const [name, stuff] of Object.entries(results.working_memory?.root ?? {})) {
  console.log(name, stuff.concept); // e.g. "text native.Text"
}
```

**Older runs carry the concept as an object.** A runtime older than pipelex 0.60.0 wrote each stuff's `concept` as the full concept object rather than its ref string: every hosted run whose `working_memory.json` was written before the hosted plane moved to that release, and every run of a bare runner still pinned below it. The artifact is relayed as it was written and never migrated. The type deliberately stays the standard's `concept: string`, which is what every run from 0.60.0 on carries, rather than widening to describe relics — so a consumer listing runs that may predate the release reads `concept` as `unknown` and narrows it itself:

```ts
const concept: unknown = stuff.concept;
const ref = typeof concept === "string" ? concept : undefined; // undefined: a pre-0.60.0 concept object
```

## `graph_spec` — the executed graph

`graph_spec` is the graph the run actually executed: `meta.mode` is `"live"`, and there is one node per pipe with its execution status, its start and end timestamps, its inputs and outputs, and the inference models and cost attributed to it. It is the same document a local `pipelex` run writes as `graphspec.json`, so anything that reads one of those files reads this value unchanged.

The field is typed `unknown` by a standing ruling ([`architecture.md`](./architecture.md#standard-artifacts-on-the-validate-report)): the canonical declaration is `GraphSpec` in `@pipelex/mthds-ui`, which carries a React peer dependency that a server-side SDK has no business taking, and the MTHDS standard declares nothing this SDK could import instead. The value is relayed verbatim either way — the typing says where the schema lives, not that the content is uncertain.

**Rendering it.** `@pipelex/mthds-ui` ships the viewer that consumes it, and its `GraphSpec` type is the cast to use on the consumer side. The viewer must be loaded client-side only, because ReactFlow touches browser globals at module evaluation, so the import goes through `next/dynamic` with `ssr: false` rather than a static one. It also fills its parent, so that parent needs `position: relative` and a height of its own or the graph renders at zero height:

```tsx
"use client";

import dynamic from "next/dynamic";
import type { RunResults } from "@pipelex/sdk";
import type { GraphSpec } from "@pipelex/mthds-ui/graph";

const GraphViewer = dynamic(
  () => import("@pipelex/mthds-ui/graph/react").then((m) => m.GraphViewer),
  { ssr: false },
);

export function RunGraph({ results }: { results: RunResults }) {
  if (!results.graph_spec) return null;
  return (
    <div style={{ position: "relative", height: "600px" }}>
      <GraphViewer
        graphspec={results.graph_spec as GraphSpec}
        // The I/O artifacts are what make a data node show its VALUE rather than the concept's
        // structure table. The viewer takes `contracts` and `outputForm` together or neither.
        contracts={results.pipe_io_contracts ?? undefined}
        outputForm={results.output_form ?? undefined}
        inputForm={results.input_form ?? undefined}
      />
    </div>
  );
}
```

**Keeping it.** The value is plain JSON, so persisting it is a write; there is no SDK helper and none is needed. Keeping it is worth doing for anything you may have to explain later, because it is the only record of what the run did pipe by pipe:

```ts
import { writeFile } from "node:fs/promises";

await writeFile("graphspec.json", JSON.stringify(results.graph_spec, null, 2));
```

**When it is null.** On the hosted path, the artifact may not have been written when the results were delivered. On either path, the runner may have assembled no graph at all — which is what the next field is for.

## `graph_assembly_error` — why there is no graph

`graph_assembly_error` is the graph's twin of `usage_assembly_error`, and it exists for the same reason: a null `graph_spec` alone cannot say whether graph assembly was off, broke, or simply had not finished writing. When the runner's assembly failed, this field carries the runner's message.

On the blocking path the SDK lifts it off `pipe_output`, beside the graph itself. **On the hosted path the key is absent, so the field reads `undefined` rather than `null`**: the platform's results body relays no such key and the SDK parses that body as it arrives, so the failure the bare runner reports is not yet observable through the hosted API. The field is declared ahead of that relay so consumers have one accessor to write against and nothing breaks the day the wire gains the key — the value appears on its own, with no SDK change. Until then, treat `undefined` on the hosted path as "no information", not as "assembly succeeded", and compare with `!= null` rather than `=== null` so that the same branch keeps working once the key arrives.

```ts
if (results.graph_assembly_error != null) {
  console.warn("graph assembly failed for this run:", results.graph_assembly_error);
} else if (results.graph_spec == null) {
  // no graph: assembly was off, the artifact was not written, or (hosted) the error is not relayed
}
```

## `pipe_io_contracts`, `input_form` and `output_form` — what the graph's data is

`graph_spec` carries the values a run produced; these three say what those values ARE. They are the validate report's own artifacts — the standard's `PipeIOContracts`, `InputForm` and `OutputForm`, imported from `mthds/protocol` rather than restated here, under the same ruling that governs them on the validate report ([`architecture.md`](./architecture.md#standard-artifacts-on-the-validate-report)) — built over the library the run actually executed against and keyed by namespaced `pipe_ref` (`domain.code`) over one shared key set. They are the same documents a local `pipelex` run writes beside its `graphspec.json` as `pipe_io_contracts.json`, `input_form.json` and `output_form.json`, so a consumer reads one thing whether the artifacts came from `/v1/validate`, from a results directory, or from a hosted run.

The contract names each pipe's inputs and its output — the concept, the multiplicity, the JSON Schema of the payload — and the two form descriptors say what each of those slots IS as a typed field, which is what a renderer needs to lay a value out without inspecting it.

**Read the contracts and the output form together.** `@pipelex/mthds-ui`'s `GraphViewer` gates a data node's value on holding both: given the pair it renders the payload, and given one or neither it falls back to the concept's structure table with no data tab. That is why they arrive as a set rather than one at a time. `input_form` is optional even then — it is what lets the method's own inputs show their values, since no pipe produced them and no output descriptor describes them.

```ts
const contracts = results.pipe_io_contracts;
const outputForm = results.output_form;
if (contracts && outputForm) {
  const summarize = contracts["my_domain.summarize"];
  console.log(summarize?.output.concept_ref); // e.g. "my_domain.Summary"
  console.log(outputForm["my_domain.summarize"]?.field.kind); // e.g. "object"
}
```

**When they are absent.** On the blocking path the SDK unwraps the runner's `pipe_io_artifacts` envelope — the runner carries the three together, since they share a key set and are built in one pass — onto these three fields, so each has one accessor whichever path ran. On the hosted path the platform does not relay the keys yet, so all three read `undefined` there today; they are declared ahead of that relay so consumers have one accessor to write against and nothing breaks the day the wire gains them. They read `null` when the run described no data at all — graph tracing off, or a runtime older than the artifacts. Compare with `!= null` rather than `=== null`, exactly as with the graph pair.

## `pipe_io_artifacts_error` — why there is no description

`pipe_io_artifacts_error` is the three artifacts' twin of `graph_assembly_error`, and it exists for the same reason: three null artifacts alone cannot say whether the run described no data or whether building the description broke. When the runner's build failed, this field carries its message. It is lifted off `pipe_output` on the blocking path and, like `graph_assembly_error`, the hosted results body relays no such key — so treat `undefined` there as "no information", not as "the build succeeded".

## `tokens_usages` and `usage_assembly_error` — what the run consumed

The usage pair reports what each inference call consumed and cost — one `TokensUsageRecord` per call, in completion order — and reads identically on both paths. The null-versus-empty semantics, the cost rules (`null` is unrated, `0` is priced at zero), the non-additive token categories and the pre-contract artifacts that still type-check all have their own page: [`run-usage.md`](./run-usage.md).

For the run's totals, call `summarizeUsage(results)` rather than adding the records up by hand: it returns the total cost, the input and output token totals and a per-pipe rollup, with a `state` that tells a run with records from one that did no inference and from one whose usage is unavailable. See [Summarizing a run](./run-usage.md#summarizing-a-run--summarizeusage).

## `pipe_output` — the runner's native output

`pipe_output` is the bare runner's whole native output, and it is present on the blocking path only — the hosted results body carries no such key, so on that path it reads `undefined`. It is supplementary: `main_stuff`, `working_memory`, the graph and the usage pair are all lifted out of it onto fields that read the same on both paths, so a consumer that wants every named stuff of the run reads `working_memory`, not `pipe_output.working_memory`, and its code keeps working against the hosted API. What `pipe_output` adds is the runner's output exactly as it arrived. It is typed `DictPipeOutput`, which is extension-open — the runner's Pipelex extension fields are reachable through the index signature without casting the whole value away. A caller holding an `execute()` result rather than a `RunResults` does that lift with `resultsFromExecute`, described at the top of this page, instead of reading the extension fields itself.

## Produced files

A run that produces an image, a PDF or a document does not embed the bytes. The content inside `main_stuff` carries the file's durable reference — a `pipelex-storage://` URI, in the content's `url` — beside a `public_url` the storage provider signed when the run wrote the file. **That signed link is short-lived and must not be stored**: it expires on the provider's own schedule, so a link persisted in a database or rendered into a cached page stops working without warning, while the `pipelex-storage://` reference beside it is permanent and is what belongs in your records.

To read the bytes, mint a fresh link from the reference:

```ts
const resolved = await client.resolveStorageUrl({ uri: "pipelex-storage://..." });
// { url, expires_at, content_type } — fetch `url` now; re-resolve for the next reader.
```

The same rule holds in a browser: resolve on the server, hand the client a link it uses immediately, and never let a presigned URL outlive the request it was minted for.

Bringing the files down is the SDK's job, not something to re-implement over `resolveStorageUrl`: `locateArtifacts` lists a result's references without touching the network, each with the paths of the fields it fills (`collectArtifacts` gives the references alone), `resolveArtifacts` mints fresh links for a whole list in one bulk call, `fetchArtifact` streams one file within safe bounds, and `downloadArtifacts` saves everything a run produced under a directory, each file named after the field it fills, by run id even days later. They all share one page, [`artifact-download.md`](./artifact-download.md). The upload direction — turning local files into `pipelex-storage://` references before a run — is the mirror of this and has its own page too, [`input-preparation.md`](./input-preparation.md).
