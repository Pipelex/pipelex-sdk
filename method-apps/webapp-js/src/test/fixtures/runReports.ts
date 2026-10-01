// ---------------------------------------------------------------------------
// TEST FIXTURE — the stored error reports of failed runs.
//
// A failed durable run's report is the runtime's `ErrorReport`, stored on the
// run and served whole by the platform (`RunRead.error`, and the `error` member
// of the results read's 409). `MODEL_NOT_ENABLED` is recorded verbatim: it is
// the report in `tests/fixtures/problems/results-409-failed.json` of
// pipelex-sdk-js at 98260ff0c1b25c8e0d8bea3ee8366094f9f30a65, which that repo
// recorded from pipelex's `LLMCompletionError` through the platform's handler.
// The other two follow the runtime's shapes for their error classes
// (`MultiplicityCountMismatchError`, and an `LLMCompletionError` classified as
// transient), with the wording of `pipelex/core/memory/exceptions.py` and
// `pipelex/cogt/inference/error_render.py`.
// ---------------------------------------------------------------------------

import type { RunErrorReport } from "@pipelex/sdk";

/** The provider's raw text inside `MODEL_NOT_ENABLED`, which a person must never read. */
export const MODEL_NOT_ENABLED_PROVIDER_TEXT =
  "Error code: 412 - {'error': {'message': 'Model global.anthropic.claude-opus-4-8 is not allowed for this integration'}}";

/** A configuration failure from a model provider: not retryable, `change_model`. */
export const MODEL_NOT_ENABLED: RunErrorReport = {
  error_type: "LLMCompletionError",
  message: `Pipe 'summarize' (path: two_steps > summarize) failed: openai inference failed for model 'claude-4.8-opus' (HTTP 412): ${MODEL_NOT_ENABLED_PROVIDER_TEXT}`,
  title: "LLM completion",
  type_uri: "https://docs.pipelex.com/latest/errors/llm-completion-error/",
  error_category: "configuration",
  error_domain: "config",
  retryable: false,
  user_action: {
    kind: "change_model",
    detail:
      "This model is not enabled on the inference gateway; choose another model for the pipe.",
  },
  model: "claude-4.8-opus",
  provider: "pipelex_gateway",
  provider_metadata: {
    provider: "openai",
    sdk_exception_type: "APIStatusError",
    message: MODEL_NOT_ENABLED_PROVIDER_TEXT,
    status_code: "412",
    request_id: "req_gw_5f1c",
    retry_after_seconds: "1.5",
  },
};

/** A caller's own input fault: not retryable, `change_input`, no provider involved. */
export const WRONG_ITEM_COUNT: RunErrorReport = {
  error_type: "MultiplicityCountMismatchError",
  message:
    "Input 'pages' declares exactly 2 items of 'native.Image' ('native.Image[2]'), but you provided 3.",
  title: "Multiplicity count mismatch",
  type_uri: "https://docs.pipelex.com/latest/errors/multiplicity-count-mismatch-error/",
  error_domain: "input",
  retryable: false,
  user_action: {
    kind: "change_input",
    detail: "Provide exactly 2 items for input 'pages'.",
  },
};

/** The provider's raw text inside `RATE_LIMITED`. */
export const RATE_LIMITED_PROVIDER_TEXT =
  "Error code: 429 - {'error': {'message': 'Rate limit reached for gpt-4o in organization org-internal on tokens per min (TPM): Limit 30000, Used 29000.', 'type': 'tokens', 'code': 'rate_limit_exceeded'}}";

/** A transient provider failure: retryable, `wait_and_retry`. */
export const RATE_LIMITED: RunErrorReport = {
  error_type: "LLMCompletionError",
  message: `Pipe 'summarize' (path: two_steps > summarize) failed: openai inference failed for model 'gpt-4o' (HTTP 429): ${RATE_LIMITED_PROVIDER_TEXT}`,
  title: "LLM completion",
  type_uri: "https://docs.pipelex.com/latest/errors/llm-completion-error/",
  error_category: "transient",
  error_domain: "runtime",
  retryable: true,
  user_action: {
    kind: "wait_and_retry",
    detail: "Transient provider error — the system will retry automatically.",
  },
  model: "gpt-4o",
  provider: "pipelex_gateway",
  provider_metadata: {
    provider: "openai",
    sdk_exception_type: "RateLimitError",
    message: RATE_LIMITED_PROVIDER_TEXT,
    status_code: "429",
    request_id: "req_rl_77a0",
  },
};
