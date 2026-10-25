// ---------------------------------------------------------------------------
// TEST FIXTURE — failed runs, as the platform answers them.
//
// A failed durable run's results read answers HTTP 409 with a `run.failed`
// problem document, and the run's own problem, why it did not succeed, nests
// in it as `run_error`; the status read carries the same problem as its
// `error`. Each run problem below is written as the platform serves it to the
// API's caller, with the type, title, domain, retry verdict and next step of
// its code's entry in the MTHDS core registry and the detail that entry's
// template gives for its parameters. `MODEL_NOT_SERVED` also carries the
// `diagnostics` member of the operator's view, which a deployment configured
// to disclose its errors in full serves to every caller, and which quotes the
// provider's raw text: the display must never show it.
// ---------------------------------------------------------------------------

import type { Problem } from "@pipelex/sdk";

/** The provider's raw text inside `MODEL_NOT_SERVED`'s diagnostics, which a person must never read. */
export const MODEL_NOT_SERVED_PROVIDER_TEXT =
  "Error code: 412 - {'error': {'message': 'Model global.anthropic.claude-opus-4-8 is not allowed for this integration'}}";

/** A deployment that does not serve the model a pipe names: `operator`, not retryable, `change_model`. */
export const MODEL_NOT_SERVED: Problem = {
  type: "https://mthds.ai/errors/model.unavailable",
  title: "This deployment serves no backend for the model",
  detail:
    "The llm model 'claude-4.8-opus' exists, but this deployment does not serve it (reason: not_allowed).",
  code: "model.unavailable",
  domain: "operator",
  retry: "no",
  next_step: {
    kind: "change_model",
    detail:
      "Use a model this deployment serves in place of 'claude-4.8-opus', or ask whoever runs the runtime to serve it.",
  },
  params: { model: "claude-4.8-opus", model_type: "llm", reason: "not_allowed" },
  location: { pipe: "summarize", path: ["two_steps", "summarize"] },
  pipeline_run_id: "run-1",
  request_id: "req_gw_5f1c",
  diagnostics: {
    error_class: "LLMCompletionError",
    message: `openai inference failed for model 'claude-4.8-opus' (HTTP 412): ${MODEL_NOT_SERVED_PROVIDER_TEXT}`,
    provider: { name: "openai", status: 412, message: MODEL_NOT_SERVED_PROVIDER_TEXT },
  },
};

/** A caller's own input fault: `input`, not retryable, `change_input`. */
export const WRONG_ITEM_COUNT: Problem = {
  type: "https://mthds.ai/errors/input.wrong_multiplicity",
  title: "An input has the wrong number of items",
  detail:
    "The input 'pages' gives 3 item or items, which does not fit the multiplicity the method declares (count).",
  code: "input.wrong_multiplicity",
  domain: "input",
  retry: "no",
  next_step: {
    kind: "change_input",
    detail:
      "Give the input 'pages' with the multiplicity the method declares, then send the request again.",
  },
  params: { input: "pages", expected: "count", expected_count: 2, provided_count: 3 },
  location: { input: "pages" },
  pipeline_run_id: "run-1",
};

/** A transient provider failure: `runtime`, retryable after a delay, `wait`. */
export const RATE_LIMITED: Problem = {
  type: "https://mthds.ai/errors/provider.rate_limited",
  title: "The provider is rate limiting this deployment",
  detail: "The provider 'openai' is rate limiting this deployment's calls to the model 'gpt-4o'.",
  code: "provider.rate_limited",
  domain: "runtime",
  retry: "yes",
  retry_after: 20,
  next_step: { kind: "wait", detail: "Wait, then run the method again." },
  params: { provider: "openai", model: "gpt-4o" },
  location: { pipe: "summarize" },
  pipeline_run_id: "run-1",
};

/**
 * The results read's answer for a failed run, `run.failed`, as the platform
 * sends it: the run's own problem nested as `run_error`, or none when the run
 * ended with no problem stored.
 */
export function runFailedAnswer(
  runError: Problem | null,
  runId = "run-1",
  runStatus = "FAILED",
): Problem {
  return {
    type: "https://mthds.ai/errors/run.failed",
    title: "The run did not succeed",
    status: 409,
    detail: `The run '${runId}' ended as '${runStatus}', without success.`,
    code: "run.failed",
    domain: "runtime",
    retry: "no",
    next_step: {
      kind: "read_run",
      detail: "Read the run's own problem in run_error to see why it did not succeed.",
    },
    params: { pipeline_run_id: runId, run_status: runStatus },
    pipeline_run_id: runId,
    request_id: "req_results_409",
    ...(runError !== null ? { run_error: runError } : {}),
  };
}
