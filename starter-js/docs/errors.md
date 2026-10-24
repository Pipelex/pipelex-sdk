# Errors: what a person reads when something goes wrong

Every failure an example can meet reaches the person using it as one `PipelineError`, rendered by `<ErrorDisplay>`, except a failed read of a run's progress, which reaches no one ([below](#the-run-timeline)). The error is classified on the server, inside the helpers that call the SDK (`executeBlockingRun`, `startDurableRun`, `pollDurableRun`, the grant action), by `classifyPipelineError` in `src/lib/errors.ts`. The helpers return the classified error instead of throwing it, since a production build of Next.js turns a thrown Server Action error into an opaque digest.

## Every error carries a problem

Every error `@pipelex/sdk` throws carries its failure as a **problem document**, the MTHDS standard's error shape (RFC 9457 with the standard's members): a refusal the API answered with one, as it received it, and every other failure (an API out of reach, a run that may have started, a base URL the SDK refused) as the problem the SDK builds for it from the standard's registry. The classification reads the problem, never the error's class name, an HTTP status or a sentence:

| Member of the problem | What the app does with it                                                                                                                                                                                                                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `code`                | The registered code, the one value the app branches on, for the few failures it words in its own terms (below). Every other code is shown from the problem's own members, so a code the app has never heard of still reads well.                                                                                |
| `domain`              | Who must act, which sets the card's tone: the person's inputs (`input`), the method's author (`method`), the account's owner (`account`), whoever runs the deployment (`operator`), or nobody beforehand, a fault in the service (`runtime`). The first three are shown as a caution, the last two as an error. |
| `next_step`           | The next step: its `detail` is the hint, except a `retry` or `wait` step, which the retry line says.                                                                                                                                                                                                            |
| `retry`               | The retry line: `yes` offers a re-run, after `retry_after` seconds when the problem gives them; `no` says a re-run unchanged fails the same way; `outcome_unknown` says the run may already have started, so it is looked up by its id before anything is started again.                                        |
| `request_id`          | The request's id, on the support line and in the details, where it can be copied.                                                                                                                                                                                                                               |
| `title`, `detail`     | The headline and what happened, for a problem the app has no copy of its own for.                                                                                                                                                                                                                               |
| `params`, `errors`    | The technical details: the code's parameters, and each item of a refusal with several faults (a method that does not validate, for instance) with where it is, its close matches and its suggested fix.                                                                                                         |

A refusal whose body was no problem document (an edge in front of the API answering with a bare status) carries the problem the SDK reads that status as, and the details say so: `problem: the SDK's reading of the HTTP status, not a document the API sent`.

## The fields of a classified error

| Field        | What `<ErrorDisplay>` does with it                                                                                                                                      |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`      | The headline.                                                                                                                                                           |
| `message`    | One or two sentences on what happened, in plain language.                                                                                                               |
| `domain`     | Who must act: a line saying so, and the card's tone. Absent for a failure with no problem, such as a Server Action call the browser could not deliver.                  |
| `apiMessage` | The API's own words, in a block of their own, when `message` re-frames them.                                                                                            |
| `hint`       | The next step, with an optional snippet to copy and a link.                                                                                                             |
| `retry`      | Whether running it again can succeed, in the problem's own verdict. Set whenever the failure carries a problem, and absent otherwise, so nothing is claimed on a guess. |
| `code`       | The problem's code, in the support line and the details.                                                                                                                |
| `requestId`  | The request's id, in the support line.                                                                                                                                  |
| `support`    | One line to quote to support, shown selectable, with the run's id ahead of it when the run had started.                                                                 |
| `details`    | The raw technical facts, in a "Technical details" disclosure that starts closed.                                                                                        |

## A failed durable run

A durable run that ends without a result is read from **its own problem**. The results read answers a failed run with a `run.failed` problem, which says the run is over and nests the run's own problem, why it did not succeed, as `run_error`; the status read carries the same problem as its `error`. `pollDurableRun` builds the `RunFailedError` it classifies from the results read's `run.failed`, with the status read's problem nested in it when the results read nests none, and passes the status read's `finished_at` along. The classification reads the display from the run's problem:

| The display       | From the run's problem                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------- |
| The headline      | "The pipeline run failed: " and its `title`.                                                                    |
| What happened     | Its `detail`.                                                                                                   |
| Who must act      | Its `domain`.                                                                                                   |
| The next step     | Its `next_step.detail`, except a `retry` or `wait` step, which the retry line says.                             |
| The retry line    | Its `retry`, with its `retry_after` when it gives one.                                                          |
| The support line  | `run <id> · <code> · failed <UTC time>`, then `request <id>`: the run's problem's own, else the results read's. |
| Technical details | The run's status, then the problem's code, domain, verdict, next step, parameters and items.                    |

**Only the problem's registered members are shown.** A deployment configured to disclose its errors in full serves the operator's view of a run's problem, whose `diagnostics` member quotes the error's own message and what the model provider said, which can be the raw body of the provider's error or a whole HTML page. The display reads none of it, the technical details included: the members it shows are the ones the standard registers, written from the code's registry entry.

**A run with no problem of its own keeps the `run.failed` sentence**, "The run 'run\_…' ended as 'FAILED', without success.", with the bare run id and no retry line. That is a run whose start failed, one cancelled or terminated with nothing recorded, and every failed run on a platform that stores no problem. Nothing then says why it failed, nor whether it would pass a second time: the `run.failed` verdict judges reading the run again, which only finds it over.

## A refused run

When the runtime refuses to run a method, at `/v1/start` in durable mode or at `/v1/execute` in blocking mode, the SDK throws an `ApiResponseError` whose `problem` is the problem document the API answered. Unless its code is one of the few below, it is shown from the problem alone: a `bad_request` when the fault is on the caller's side (its domain is `input`, `method` or `account`), a `server_error` when it is the service's (`runtime` or `operator`), its title as the headline, its detail as what happened, its next step as the hint, and its verdict as the retry line. A method that does not validate, for instance, is `method.invalid`, and each of its faults is an item of its `errors`, listed in the technical details with where it is and, for a model no catalog knows, its close matches.

## The codes the app words itself

A few codes name a failure this app can say more about in its own terms, usually because the remedy is a change to its configuration:

| Code                                                                            | Kind                                                  | What the app says                                                                                                                                                                                      |
| ------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `client.unreachable`, `client.timeout`                                          | `api_unreachable`                                     | The API did not answer, or not in time: check `PIPELEX_BASE_URL` when it is customized, the network otherwise. No domain is claimed, since the URL or the network is as likely a cause as the service. |
| `auth.missing_credential`, `auth.invalid_credential`, `auth.credential_expired` | `auth_missing` or `auth_invalid`                      | The key in `.env.local` is missing or refused, whichever this app knows it sent.                                                                                                                       |
| `client.not_configured`                                                         | `config_invalid`                                      | `PIPELEX_BASE_URL` names more than a host (below).                                                                                                                                                     |
| `client.argument_invalid`                                                       | `unknown`                                             | The SDK refused a call this app made: a fault in the app's code, so no domain is claimed for the person.                                                                                               |
| `client.response_unreadable`                                                    | `bad_response`                                        | The API answered with something the SDK could not read, a `2xx` included: never a refusal.                                                                                                             |
| `client.outcome_unknown`                                                        | `outcome_unknown`, or `execute_timeout` when blocking | A durable start failed after it left, so the run may have started: look it up before starting another. On the blocking path, the hosted gateway's ~30s cap, whose remedy is Durable mode.              |
| `client.follow_failed`                                                          | `run_timeout`, or `run_still_running` when blocking   | The SDK stopped following a run that keeps going: read it by its id.                                                                                                                                   |
| `run.failed`                                                                    | `run_failed`                                          | The run's own problem, as above.                                                                                                                                                                       |
| `runtime.unsupported`                                                           | `lifecycle_unavailable` or `upload_unavailable`       | The configured API lacks durable runs, asynchronous execution or file upload, which the hosted Pipelex API offers.                                                                                     |
| `request.not_found`, `request.too_large` on an upload grant                     | `upload_unavailable`, `file_too_large`                | The API serves no upload grants, or the platform refused the file's size, in its own words.                                                                                                            |

## A poll tick that failed

A status read that fails while a durable run is going says nothing about the run, which keeps executing server-side. `pollDurableRun` flags the failure transient when its problem's `retry` is `yes` (a gateway `5xx`, a rate limit, a timeout, a network blip) and hands `useRun` the problem's `retry_after`; the poll loop keeps reading, waiting at least that long, up to its budget of consecutive failures. The error then carries no retry line: its verdict judged the read, not the run, and offering a re-run of a run that may still be executing would start a second one.

## Other failures

A failure that carries no problem (an output that does not match the method's contract, an image a browser cannot load, a bundle missing from disk, a Server Action call the browser could not deliver) has its own branch in `classifyPipelineError`, and [`CLAUDE.md`](../CLAUDE.md) says how to add one. A file's upload fails in the browser, where `classifyUploadError` words it by the SDK's `reason`, the closed vocabulary of what storage refused or why the upload never got its verdict, and offers to drop the file again only when the problem's verdict says that can pass.

**A refused `PIPELEX_BASE_URL` is never quoted.** The SDK refuses a value that names more than a host, which may carry credentials or a token in its query, while the technical details reach every visitor of a deployed app. So `classifyConfigRefusal` relays no message about it and shows the value cut down to its scheme and host, naming the parts beyond them without their content: `PIPELEX_BASE_URL: https://proxy.example.com, with credentials and a query (not shown)`.

## The run timeline

**A failure to read a run's progress reaches no one.** The run timeline is an addition to the run's status, never a gate on it: its route answers a failed read with a bare error status or `unavailable`, the browser keeps the snapshot it holds, and the status poll alone decides how the run ends and shows what went wrong. **Its snapshot follows this page's rule about the provider's raw text**: the route replaces each invocation's failure with one fixed sentence and words each degradation from its reason, so neither the platform's words nor a provider's text leaves the server. [`docs/run-timeline.md`](run-timeline.md) is the reference.
