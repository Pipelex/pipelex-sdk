// ---------------------------------------------------------------------------
// TEST FIXTURE — a run the runner refused, as the SDK hands it back.
//
// A runner that refuses to run a method answers the run route (`/v1/start`,
// relayed by the platform, or `/v1/execute`) with a problem document, and
// `@pipelex/sdk` throws it as an `ApiResponseError` whose members are the
// document's. The body below is the one mthds-js records for that refusal in
// `tests/unit/agent/run-refusal.test.ts` (its `UNKNOWN_MODEL_ITEM` and the 422
// around it, at mthds-js 01c237b), which follows the unknown-model item the
// runtime's bundle-refusal verdicts produce.
// ---------------------------------------------------------------------------

import { ApiResponseError, type ValidationErrorItem } from "@pipelex/sdk";

/** An unknown model, with the locators the runtime adds beside the declared fields. */
export const UNKNOWN_MODEL_ITEM = {
  category: "pipe_validation",
  error_type: "unknown_model",
  message: "Model handle 'gpt-5.1' was not found in the model deck. Did you mean: gpt-5?",
  pipe_code: "summarize",
  domain_code: "demo",
  field_path: "pipe.summarize.model",
  field_name: "model",
  model_reference: "gpt-5.1",
  model_type: "llm",
  suggestions: ["gpt-5"],
} as ValidationErrorItem;

export const REFUSAL_BODY = {
  type: "https://pipelex.com/errors/validate-bundle",
  title: "Invalid bundle",
  status: 422,
  detail: "The method is invalid.",
  error_type: "ValidateBundleError",
  error_domain: "input",
  retryable: false,
  user_action: { kind: "change_input", detail: "Fix the bundle, then run it again." },
  request_id: "req-run-422",
  validation_errors: [UNKNOWN_MODEL_ITEM],
};

/** The refused start, as the SDK's parser builds it from `REFUSAL_BODY`. */
export function refusedStart(): ApiResponseError {
  return new ApiResponseError(
    "API POST /v1/start failed (422): The method is invalid.",
    "https://api.pipelex.com",
    422,
    "Unprocessable Entity",
    JSON.stringify(REFUSAL_BODY),
    REFUSAL_BODY.error_type,
    REFUSAL_BODY.detail,
    REFUSAL_BODY.validation_errors,
    undefined,
    {
      problem: {
        type: REFUSAL_BODY.type,
        title: REFUSAL_BODY.title,
        requestId: REFUSAL_BODY.request_id,
        errorDomain: REFUSAL_BODY.error_domain,
        retryable: REFUSAL_BODY.retryable,
        userAction: REFUSAL_BODY.user_action,
      },
      problemDocument: REFUSAL_BODY,
    },
  );
}
