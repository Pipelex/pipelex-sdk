// ---------------------------------------------------------------------------
// TEST FIXTURE — a run the runtime refused, as the SDK hands it back.
//
// A runtime that refuses to run a method answers the run route (`/v1/start`,
// relayed by the platform, or `/v1/execute`) with a problem document, and
// `@pipelex/sdk` throws it as an `ApiResponseError` whose `problem` is that
// document as received. The body below is the refusal of a method that names
// a model no catalog knows: `method.invalid`, carrying one `model.unknown`
// item with where it is and the catalog's close match, each written with its
// code's entry in the MTHDS core registry.
// ---------------------------------------------------------------------------

import { ApiResponseError, type Problem, type ProblemItem } from "@pipelex/sdk";

/** An unknown model, with the reference the method wrote and the catalog's close matches. */
export const UNKNOWN_MODEL_ITEM: ProblemItem = {
  code: "model.unknown",
  detail: "The method names the llm model 'gpt-5.1', which no catalog knows.",
  params: { model: "gpt-5.1", model_type: "llm", suggestions: ["gpt-5"] },
  location: { pipe: "summarize", field: "model", file: "method.mthds", line: 12 },
  suggestions: ["gpt-5"],
};

export const REFUSAL_BODY: Problem = {
  type: "https://mthds.ai/errors/method.invalid",
  title: "The method does not validate",
  status: 422,
  detail: "The method does not validate.",
  code: "method.invalid",
  domain: "method",
  retry: "no",
  next_step: {
    kind: "change_method",
    detail: "Fix each fault the problem's errors list, then validate the method again.",
  },
  errors: [UNKNOWN_MODEL_ITEM],
  request_id: "req-run-422",
};

/** The refused start, as the SDK's client builds it from `REFUSAL_BODY`. */
export function refusedStart(): ApiResponseError {
  return new ApiResponseError(
    `API POST /v1/start failed (422): ${REFUSAL_BODY.detail}`,
    "https://api.pipelex.com",
    422,
    "Unprocessable Entity",
    JSON.stringify(REFUSAL_BODY),
    { mayStartRun: true },
  );
}
