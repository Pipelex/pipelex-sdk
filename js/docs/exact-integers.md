# Integers past `Number.MAX_SAFE_INTEGER`

JavaScript reads every JSON number as a double, which holds an integer exactly only up to `Number.MAX_SAFE_INTEGER` (2^53 - 1). A person's data can hold a larger one, such as `12345678901234567891`, which a double reads as `12345678901234567000`. Read that way and sent back, as a rerun's inputs or an example's, the rounded number would run the method on data nobody gave it, with no sign that anything changed. The Python SDK has no such limit, since Python's integers are exact.

So the client reads every answer that carries a person's data with `parseExactJson`, and writes every request body with `stringifyExactJson`. Both live in `src/exact-json.ts`, and the barrel exports them.

## Which reads are exact

| Read | What it carries |
|---|---|
| `getRunDetail` | The run's `inputs`. |
| `getRunResult`, and `waitForResult` and `startAndWaitForResult` through it | A completed run's results: `main_stuff`, `working_memory`, `graph_spec` and every other field of the answer. |
| `execute`, and `startAndWaitForResult`'s blocking path through it | The working memory in `pipe_output`, and so the `main_stuff` resolved from it. |
| `createMethodExample`, `listMethodExamples`, `iterateMethodExamples`, `getMethodExample`, `updateMethodExample`, `recordMethodExampleLatestRun` | Each example's `inputs` ([method-examples.md](./method-examples.md#numbers-in-an-examples-inputs)). |

In these answers, an integer past the safe range in either direction, at any depth, reads as a `bigint` holding its exact digits, and every other value reads as `JSON.parse` reads it. Every other read uses `JSON.parse`: the run status read and the run history, whose fields are the run's bookkeeping rather than its data, and the rest of the product surface.

**A `bigint` needs the SDK's writer to become JSON text.** `String(value)` shows its digits, but `JSON.stringify` throws a `TypeError` on one, so code that shows such data as JSON text writes it with `stringifyExactJson(value, 2)`, and reads text a person edited back with `parseExactJson`. The `pipelex-sdk` command prints a run's output this way. Arithmetic on a `bigint` takes another `bigint`, so code that sums the numbers of an output converts it first, knowing it may lose digits.

## The writer

`stringifyExactJson` writes a value as `JSON.stringify` writes it. A value holding no `bigint` is written by one plain `JSON.stringify` call; one holding a `bigint` is written again with each `bigint` as raw JSON text (`JSON.rawJSON`), so its digits go to the platform unchanged. The client writes every request body this way before the request is made, so a body JSON cannot carry, such as one holding a cycle, is refused with `RequestArgumentError` before anything is sent ([errors.md](./errors.md)).

## A float keeps its value, not its spelling

A number with a fraction or an exponent stays a double. A float with no fractional part, `3.0`, reads as `3` and is written back as `3`, as everywhere in JavaScript: the value is the same, so a run started with it runs as given. Only an example's edit can tell them apart, since the platform compares an example's inputs as canonical JSON ([method-examples.md](./method-examples.md#numbers-in-an-examples-inputs)).

## The runtime it needs

Both functions rest on the JSON source-text proposal, which every runtime the package supports (Node 22.12 and later) provides: the reader on the source text `JSON.parse` hands its reviver, the writer on `JSON.rawJSON`. The reader is that one `JSON.parse` call with a reviver, so it reads strings, escapes, repeated keys and `__proto__` exactly as `JSON.parse` does; a text holding no run of 16 digits, and so no integer past the safe range, is read without the reviver.

On a runtime without them, neither ever rounds. The reader refuses a number past the safe range that reads as a whole number with `ExactJsonUnsupportedError` (`config`, not retryable), since without the source text it cannot tell `12345678901234567891` from `1.2345678901234567e19`; the client reports it as the `ApiResponseError` of an answer it cannot read (`runtime`, not retryable), with that refusal as `cause`. The writer refuses a `bigint` with the `TypeError` `JSON.stringify` throws for one, which the client reports as `RequestArgumentError` before anything is sent.
