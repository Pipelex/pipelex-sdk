/**
 * A validation item reaches a caller with everything the runner put on it.
 *
 * Two things are shown. At run time, an `unknown_model` item — a model reference the
 * runner's model deck does not know — keeps the reference as written, its kind, the close
 * matches and the remap fix, on the two channels a refusal takes: the `/v1/validate`
 * invalid verdict and a run route's `422` problem document. At compile time, the fix's
 * operation and safety vocabularies are pinned to `mthds`'s, which the standard's problem
 * items share, so a kind the standard adds and this SDK misses, or the reverse, fails
 * `npm run typecheck:test`, which `make check` runs; `expectTypeOf` is erased at run time,
 * so vitest alone would not catch it. The item itself is the hosted plane's, which predates
 * the standard's problem items, so it is not pinned to them.
 */

import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
// The test is outside `src/`, so it may read the package root that `.dependency-cruiser.cjs`
// keeps the SDK itself from importing.
import type {
  FixOpKind as MthdsFixOpKind,
  FixSafety as MthdsFixSafety,
  FixValue as MthdsFixValue,
} from "mthds";

import { PipelexApiClient } from "../src/client.js";
import { ApiResponseError } from "../src/errors.js";
import type {
  FixOpKind,
  FixSafety,
  FixValue,
  TomlValue,
  ValidationErrorItem,
} from "../src/index.js";

const BASE_URL = "http://localhost:8081";

function makeClient(): PipelexApiClient {
  return new PipelexApiClient({ baseUrl: BASE_URL, apiKey: "test-token" });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * The item a runner sends for `model = "gpt-5.1"` in pipe `summarize`, as it serializes it
 * (`exclude_none`): one close match, so the item carries a `rename-model` fix remapping the
 * reference to it.
 */
const UNKNOWN_MODEL_ITEM = {
  category: "pipe_validation",
  error_type: "unknown_model",
  message: "Model handle 'gpt-5.1' was not found in the model deck. Did you mean: gpt-5?",
  pipe_code: "summarize",
  domain_code: "demo",
  source: "demo.mthds",
  field_path: "pipe.summarize.model",
  field_name: "model",
  model_reference: "gpt-5.1",
  model_type: "llm",
  suggestions: ["gpt-5"],
  suggested_fix: {
    fix_code: "rename-model",
    description:
      "Replace model 'gpt-5.1' of pipe 'summarize' with 'gpt-5', its one close match in the model deck",
    safety: "safe",
    source: "demo.mthds",
    ops: [
      {
        kind: "remap_value",
        table_path: ["pipe", "summarize"],
        key: "model",
        mapping: { "gpt-5.1": "gpt-5" },
      },
    ],
  },
} satisfies ValidationErrorItem;

/** Reads the item through its declared members only: this compiles only while they exist. */
function expectTheModelAndItsNextStep(item: ValidationErrorItem | undefined): void {
  expect(item).toEqual(UNKNOWN_MODEL_ITEM);
  expect(item?.pipe_code).toBe("summarize");
  expect(item?.model_reference).toBe("gpt-5.1");
  expect(item?.model_type).toBe("llm");
  expect(item?.suggestions).toEqual(["gpt-5"]);
  const fix = item?.suggested_fix;
  expect(fix?.description).toContain("with 'gpt-5'");
  const op = fix?.ops[0];
  if (op?.kind !== "remap_value") throw new Error("expected a remap_value op");
  expect(op.key).toBe("model");
  expect(op.mapping).toEqual({ "gpt-5.1": "gpt-5" });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("an unknown model's refusal reaches the caller whole", () => {
  it("keeps the model, its kind, the suggestions and the fix on the validate verdict", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        is_valid: false,
        validation_errors: [UNKNOWN_MODEL_ITEM],
        pending_signatures: [],
        is_runnable: false,
        message: "MTHDS validation found errors",
      }),
    );

    const report = await client.validate({ files: { "demo.mthds": "domain = 'demo'" } });

    if (report.is_valid !== false) throw new Error("expected the invalid arm");
    expectTheModelAndItsNextStep(report.validation_errors[0]);
  });

  it("keeps them on a run route's 422 problem document", async () => {
    // The runner's `ValidateBundleError` rendered as a problem document: the shape a run
    // route answers when the runner refuses the method for its validation errors.
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(422, {
        type: "https://docs.pipelex.com/latest/errors/validate-bundle-error/",
        title: "Bundle validation failed",
        status: 422,
        detail: "MTHDS validation found errors",
        error_type: "ValidateBundleError",
        error_domain: "input",
        validation_errors: [UNKNOWN_MODEL_ITEM],
      }),
    );

    const err = await client
      .execute({ pipe_code: "summarize", files: { "demo.mthds": "domain = 'demo'" } })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiResponseError);
    const refusal = err as ApiResponseError;
    expect(refusal.errorDomain).toBe("input");
    expect(refusal.validationErrors).toHaveLength(1);
    expectTheModelAndItsNextStep(refusal.validationErrors?.[0]);
  });
});

describe("the fix vocabulary is the standard's", () => {
  it("declares the operation kinds, the safeties and the written values as mthds does", () => {
    expectTypeOf<FixOpKind>().toEqualTypeOf<MthdsFixOpKind>();
    expectTypeOf<FixSafety>().toEqualTypeOf<MthdsFixSafety>();
    expectTypeOf<FixValue>().toEqualTypeOf<MthdsFixValue>();
    expectTypeOf<TomlValue>().toEqualTypeOf<MthdsFixValue>();
  });
});
