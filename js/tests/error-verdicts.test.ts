/**
 * The verdict every error carries — `retryable` and `errorDomain` — driven through the case file
 * `fixtures/error-verdicts.json`.
 *
 * The file is the contract between this package and `pipelex-sdk` (Python), which must follow it
 * too: the Python suite is to keep a byte-for-byte copy and drive its own code through the same
 * cases, with a check at the repository's root holding the two copies identical. Here:
 *
 * - every `fallback` case drives the fallback table directly, and an `ApiResponseError` built
 *   with nothing but that status, code and naming;
 * - every `server_sent` case is answered to a real client call, so the body goes through the
 *   client's own parsing;
 * - every class in `classes` is built from each variant's `given` by a builder below, and a class
 *   with no builder fails the suite, so a case added to the file reaches this language;
 * - and the completeness test walks the package entry, failing on an exported error class the
 *   file does not list or whose instance `errorVerdictOf` cannot read.
 */

import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiResponseError as MthdsApiResponseError } from "mthds/errors";
import * as protocol from "mthds/protocol";

import { PipelexApiClient } from "../src/client.js";
import { CodegenLockError } from "../src/codegen-check.js";
import type { RunErrorReport } from "../src/error-models.js";
import { fallbackVerdict } from "../src/error-verdicts.js";
import {
  ApiResponseError,
  ApiUnreachableError,
  ArtifactAuthenticationError,
  ArtifactFetchError,
  ArtifactOperationError,
  EmptyMethodSourceError,
  InputPreparationError,
  InvalidLocalSourceError,
  MissingMainStuffError,
  PagingNotTerminatingError,
  PipelexRequestError,
  PipelineExecuteTimeoutError,
  PipelineRequestError,
  RejectedAssetError,
  RunFailedError,
  RunLifecycleUnavailableError,
  RunStillRunningError,
  RunTimeoutError,
  ScopeUnavailableError,
  UnsupportedUploadCapabilityError,
  UploadAuthenticationError,
  UploadTransportError,
  errorVerdictOf,
  type ErrorDomain,
  type ErrorVerdict,
  type RejectedAssetCode,
  type UploadTransportCode,
} from "../src/errors.js";
import * as entry from "../src/index.js";

// ── The case file ────────────────────────────────────────────────────

/** A verdict as the case file spells it, in snake_case. */
interface WireVerdict {
  error_domain: ErrorDomain;
  retryable: boolean;
}

interface FallbackCase {
  case: string;
  status: number;
  code: string | null;
  named: boolean;
  expected: WireVerdict;
}

interface ServerSentCase {
  case: string;
  status: number;
  body: Record<string, unknown> | string | null;
  expected: WireVerdict;
}

/** A wrapped error: an SDK class built from its own members, or `Error`, which carries no verdict. */
interface CauseSpec {
  class: "ApiResponseError" | "ApiUnreachableError" | "Error";
  status?: number;
  body?: Record<string, unknown> | string | null;
  code?: string | null;
}

interface Given {
  code?: string | null;
  status?: number | null;
  body?: Record<string, unknown> | string | null;
  report?: Record<string, unknown> | null;
  cause?: CauseSpec;
  verdict?: WireVerdict;
}

interface Variant {
  variant: string;
  only_in?: "js" | "python";
  given: Given;
  expected: WireVerdict;
}

interface ClassEntry {
  class: string;
  only_in?: "js" | "python";
  abstract?: boolean;
  variants: Variant[];
}

interface CaseFile {
  about: string;
  fallback: FallbackCase[];
  server_sent: ServerSentCase[];
  classes: ClassEntry[];
}

const CASES = JSON.parse(
  readFileSync(new URL("./fixtures/error-verdicts.json", import.meta.url), "utf8"),
) as CaseFile;

/** Whether an entry of the file is this SDK's to drive. */
function isOurs(item: { only_in?: string }): boolean {
  return item.only_in === undefined || item.only_in === "js";
}

const OUR_CLASSES = CASES.classes.filter(isOurs);

// ── Building each class from a variant's `given` ─────────────────────

const BASE_URL = "http://localhost:8081";

function toVerdict(wire: WireVerdict): ErrorVerdict {
  return { errorDomain: wire.error_domain, retryable: wire.retryable };
}

function answer(status: number, body: Record<string, unknown> | string | null): Response {
  if (body === null) return new Response(null, { status });
  if (typeof body === "string") return new Response(body, { status });
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/problem+json" },
  });
}

/** The `ApiResponseError` a real client call throws when the API answers `status` and `body`. */
async function refusedWith(
  status: number,
  body: Record<string, unknown> | string | null,
): Promise<ApiResponseError> {
  const spy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(answer(status, body));
  try {
    const client = new PipelexApiClient({ baseUrl: BASE_URL, apiKey: "test-token" });
    const err = await client.getMe().then(
      () => expect.fail(`expected a ${status} to throw`),
      (thrown: unknown) => thrown,
    );
    expect(err).toBeInstanceOf(ApiResponseError);
    return err as ApiResponseError;
  } finally {
    spy.mockRestore();
  }
}

async function causeFrom(spec: CauseSpec | undefined): Promise<Error | undefined> {
  if (spec === undefined) return undefined;
  switch (spec.class) {
    case "ApiResponseError":
      return refusedWith(spec.status!, spec.body ?? null);
    case "ApiUnreachableError":
      return new ApiUnreachableError("Could not reach the API.", BASE_URL, spec.code ?? undefined);
    case "Error":
      return new Error("A failure carrying no verdict.");
  }
}

/**
 * One builder per class the file lists, keyed by the class's name. A class the file lists for
 * this SDK with no builder here fails the suite.
 */
const BUILDERS: Record<string, (given: Given) => Promise<Error> | Error> = {
  ApiResponseError: (given) => refusedWith(given.status!, given.body ?? null),
  ApiUnreachableError: (given) =>
    new ApiUnreachableError("Could not reach the API.", BASE_URL, given.code ?? undefined),
  PipelineExecuteTimeoutError: () => new PipelineExecuteTimeoutError(31_000),
  RunFailedError: (given) =>
    new RunFailedError("Run finished with status FAILED.", "run-1", "FAILED", {
      error: (given.report ?? null) as RunErrorReport | null,
    }),
  RunTimeoutError: () => new RunTimeoutError("Stopped waiting.", "run-1", 1_000),
  RunStillRunningError: () => new RunStillRunningError("Still running.", "run-1"),
  RunLifecycleUnavailableError: () =>
    new RunLifecycleUnavailableError("No run lifecycle here.", BASE_URL),
  MissingMainStuffError: () => new MissingMainStuffError("No main stuff.", "run-1"),
  PagingNotTerminatingError: () => new PagingNotTerminatingError("Paging forever.", 10_000),
  InputPreparationError: (given) =>
    new InputPreparationError(
      "Cannot prepare inputs.",
      given.verdict === undefined ? undefined : { verdict: toVerdict(given.verdict) },
    ),
  EmptyMethodSourceError: () => new EmptyMethodSourceError("mt_1"),
  InvalidLocalSourceError: () => new InvalidLocalSourceError("No such file.", "/nope.pdf"),
  RejectedAssetError: (given) =>
    new RejectedAssetError("Refused.", "a.pdf", given.status ?? 413, {
      code: (given.code ?? undefined) as RejectedAssetCode | undefined,
    }),
  UnsupportedUploadCapabilityError: () => new UnsupportedUploadCapabilityError("No upload here."),
  UploadAuthenticationError: (given) =>
    new UploadAuthenticationError("Not authorized.", given.status ?? 401),
  UploadTransportError: async (given) =>
    new UploadTransportError("The upload failed.", {
      cause: await causeFrom(given.cause),
      status: given.status ?? undefined,
      code: (given.code ?? undefined) as UploadTransportCode | undefined,
    }),
  ArtifactOperationError: (given) =>
    new ArtifactOperationError(
      "The artifact operation failed.",
      given.verdict === undefined ? undefined : { verdict: toVerdict(given.verdict) },
    ),
  ScopeUnavailableError: () => new ScopeUnavailableError("main_stuff", "run-1"),
  ArtifactAuthenticationError: (given) =>
    new ArtifactAuthenticationError("Credential refused.", given.status ?? 401, {
      scope: "main_stuff",
      artifacts: [],
      saved_paths: [],
      all_saved: true,
    }),
  ArtifactFetchError: (given) =>
    new ArtifactFetchError(
      "The fetch failed.",
      "pipelex-storage://org/runs/r/outputs/a.png",
      given.code!,
      given.status ?? undefined,
    ),
  CodegenLockError: () => new CodegenLockError("Malformed codegen lock."),
};

/** The exported class a file entry names, looked up on the package entry. */
function exportedClass(name: string): abstract new (...args: never[]) => Error {
  const value = (entry as Record<string, unknown>)[name];
  expect(value, `the package entry exports ${name}`).toBeTypeOf("function");
  return value as abstract new (...args: never[]) => Error;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ── The suites ───────────────────────────────────────────────────────

describe("the case file", () => {
  it("says what it is and that its copy must stay identical", () => {
    expect(CASES.about).toMatch(/byte for byte identical/);
    expect(CASES.fallback.length).toBeGreaterThan(0);
    expect(CASES.server_sent.length).toBeGreaterThan(0);
    expect(CASES.classes.length).toBeGreaterThan(0);
  });

  it("has a builder for exactly the classes it lists for this SDK", () => {
    const listed = OUR_CLASSES.filter((entry) => entry.abstract !== true).map((e) => e.class);
    expect(Object.keys(BUILDERS).sort()).toEqual([...listed].sort());
  });
});

describe("the fallback table", () => {
  it.each(CASES.fallback.map((c) => [c.case, c] as const))("%s", (_, c) => {
    const expected = toVerdict(c.expected);

    expect(fallbackVerdict(c.status, c.code ?? undefined, c.named)).toEqual(expected);

    // An ApiResponseError carrying no server member takes the same pair. A named case with no
    // platform code is named by a runner's `error_type`.
    const errorType = c.named && c.code === null ? "PipeNotFoundError" : undefined;
    const err = new ApiResponseError(
      `HTTP ${c.status}`,
      BASE_URL,
      c.status,
      "",
      "",
      errorType,
      undefined,
      undefined,
      c.code ?? undefined,
    );
    expect(errorVerdictOf(err)).toEqual(expected);
  });
});

describe("a verdict the server sent", () => {
  it.each(CASES.server_sent.map((c) => [c.case, c] as const))("%s", async (_, c) => {
    const err = await refusedWith(c.status, c.body);

    expect({ errorDomain: err.errorDomain, retryable: err.retryable }).toEqual(
      toVerdict(c.expected),
    );
    // What the server sent stays readable, whatever the verdict became.
    if (c.body !== null && typeof c.body === "object") {
      expect(err.problemDocument).toEqual(c.body);
    }
  });
});

describe("each exported class's verdict", () => {
  describe.each(OUR_CLASSES.map((c) => [c.class, c] as const))("%s", (name, classEntry) => {
    if (classEntry.abstract === true) {
      it("is the base every concrete SDK request error derives from", () => {
        const base = exportedClass(name);
        expect(base).toBe(PipelexRequestError);
        expect(PipelexRequestError.prototype).toBeInstanceOf(PipelineRequestError);
        for (const other of OUR_CLASSES) {
          if (other.abstract === true || other.class === "CodegenLockError") continue;
          expect(exportedClass(other.class).prototype, other.class).toBeInstanceOf(base);
        }
      });
      return;
    }

    it("has a builder", () => {
      expect(BUILDERS[name], `no builder for ${name}: add one to BUILDERS`).toBeTypeOf("function");
    });

    const variants = classEntry.variants.filter(isOurs);
    it.each(variants.map((v) => [v.variant, v] as const))("%s", async (_, variant) => {
      const build = BUILDERS[name];
      if (build === undefined) expect.fail(`no builder for ${name}`);
      const err = await build(variant.given);
      const expected = toVerdict(variant.expected);

      expect(err).toBeInstanceOf(exportedClass(name));
      expect(err.name).toBe(name);
      expect(errorVerdictOf(err)).toEqual(expected);
      const own = err as Error & ErrorVerdict;
      expect({ errorDomain: own.errorDomain, retryable: own.retryable }).toEqual(expected);
      expect(Object.hasOwn(err, "retryable")).toBe(true);
      expect(Object.hasOwn(err, "errorDomain")).toBe(true);
    });
  });
});

describe("completeness: every exported error class is in the case file", () => {
  // The standard's own classes ride the protocol re-export; they are `mthds`'s, not this SDK's.
  const protocolExports = protocol as Record<string, unknown>;
  const errorClasses = Object.entries(entry as Record<string, unknown>).filter(
    ([name, value]) =>
      typeof value === "function" &&
      (value === Error || value.prototype instanceof Error) &&
      protocolExports[name] !== value,
  );

  it("finds the SDK's error classes on the package entry", () => {
    expect(errorClasses.map(([name]) => name)).toContain("ApiResponseError");
    expect(errorClasses.map(([name]) => name)).toContain("CodegenLockError");
  });

  it.each(errorClasses.map(([name]) => [name] as const))("%s", async (name) => {
    const classEntry = OUR_CLASSES.find((c) => c.class === name);
    expect(classEntry, `${name} is exported but missing from the case file`).toBeDefined();
    if (classEntry!.abstract === true) return;
    const variant = classEntry!.variants.find(isOurs);
    expect(variant, `${name} has no variant for this SDK in the case file`).toBeDefined();
    const err = await BUILDERS[name]!(variant!.given);
    expect(errorVerdictOf(err), `errorVerdictOf cannot read a ${name}`).toBeDefined();
  });
});

describe("errorVerdictOf", () => {
  it("returns undefined for a misused argument's RangeError and TypeError", () => {
    expect(
      errorVerdictOf(new RangeError('"timeoutMs" must be a positive number.')),
    ).toBeUndefined();
    expect(errorVerdictOf(new TypeError("appInfo must be an object."))).toBeUndefined();
  });

  it("returns undefined for the caller's own abort, as the client rethrows it", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) =>
      Promise.reject((init as RequestInit).signal!.reason),
    );
    const client = new PipelexApiClient({ baseUrl: BASE_URL, apiKey: "test-token" });

    const err = await client.getRunStatus("run-1", { signal: controller.signal }).then(
      () => expect.fail("expected the aborted read to throw"),
      (thrown: unknown) => thrown,
    );

    expect(err).toBe(controller.signal.reason);
    expect(errorVerdictOf(err)).toBeUndefined();
    // An abort reason can be any value a caller chose.
    const custom = new AbortController();
    custom.abort("the user walked away");
    expect(errorVerdictOf(custom.signal.reason)).toBeUndefined();
  });

  it("returns undefined for a value that is not an Error, even one shaped like a verdict", () => {
    expect(errorVerdictOf(undefined)).toBeUndefined();
    expect(errorVerdictOf(null)).toBeUndefined();
    expect(errorVerdictOf("boom")).toBeUndefined();
    expect(errorVerdictOf({ retryable: true, errorDomain: "runtime" })).toBeUndefined();
  });

  it("returns undefined for an Error whose members are missing, mistyped or unknown", () => {
    expect(errorVerdictOf(new Error("plain"))).toBeUndefined();
    expect(errorVerdictOf(Object.assign(new Error("half"), { retryable: true }))).toBeUndefined();
    expect(
      errorVerdictOf(
        Object.assign(new Error("mistyped"), { retryable: "yes", errorDomain: "input" }),
      ),
    ).toBeUndefined();
    expect(
      errorVerdictOf(
        Object.assign(new Error("unknown"), { retryable: false, errorDomain: "network" }),
      ),
    ).toBeUndefined();
  });

  it("reads any Error carrying both members, such as one from another copy of the SDK", () => {
    const foreign = Object.assign(new Error("from another copy"), {
      retryable: true,
      errorDomain: "runtime",
    });

    expect(errorVerdictOf(foreign)).toEqual({ retryable: true, errorDomain: "runtime" });
  });

  it("reads a consumer's own subclass with the verdict it declares", () => {
    class MissingInputFormError extends InputPreparationError {
      constructor() {
        super("The method describes no input form.", {
          verdict: { errorDomain: "config", retryable: false },
        });
        this.name = "MissingInputFormError";
      }
    }

    expect(errorVerdictOf(new MissingInputFormError())).toEqual({
      retryable: false,
      errorDomain: "config",
    });
  });

  it("reads an mthds ApiResponseError whose runner sent both members, and only then", () => {
    const both = new MthdsApiResponseError(
      "refused",
      BASE_URL,
      500,
      "Internal Server Error",
      "{}",
      "LLMCompletionError",
      "refused",
      undefined,
      { problem: { errorDomain: "config", retryable: false } },
    );
    const domainOnly = new MthdsApiResponseError(
      "refused",
      BASE_URL,
      500,
      "Internal Server Error",
      "{}",
      "LLMCompletionError",
      "refused",
      undefined,
      { problem: { errorDomain: "config" } },
    );

    expect(errorVerdictOf(both)).toEqual({ retryable: false, errorDomain: "config" });
    expect(errorVerdictOf(domainOnly)).toBeUndefined();
  });

  it("returns a fresh pair, not the error itself", () => {
    const err = new RunTimeoutError("Stopped waiting.", "run-1", 1_000);

    const read = errorVerdictOf(err);

    expect(read).not.toBe(err);
    expect(Object.keys(read!).sort()).toEqual(["errorDomain", "retryable"]);
  });
});

describe("uploadFile's wrapper takes its cause's verdict, through the real client", () => {
  it("is config and not retryable for a 402 plan refusal", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      answer(402, {
        type: "https://pipelex.com/errors/payment_required",
        title: "Payment required",
        status: 402,
        code: "payment_required",
        detail: "The organization has no credit left.",
      }),
    );
    const client = new PipelexApiClient({ baseUrl: BASE_URL, apiKey: "test-token" });

    const err = await client.uploadFile(new Uint8Array([1, 2, 3]), { filename: "a.pdf" }).then(
      () => expect.fail("expected the upload to throw"),
      (thrown: unknown) => thrown,
    );

    expect(err).toBeInstanceOf(UploadTransportError);
    const wrapper = err as UploadTransportError;
    // The coarse transport code says nothing about a plan; the wrapped refusal does.
    expect(wrapper.code).toBe("unexpected");
    expect(wrapper.cause).toBeInstanceOf(ApiResponseError);
    expect(wrapper.errorDomain).toBe("config");
    expect(wrapper.retryable).toBe(false);
  });

  it("is config and retryable when the API cannot be reached", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }),
    );
    const client = new PipelexApiClient({ baseUrl: BASE_URL, apiKey: "test-token" });

    const err = await client.uploadFile(new Uint8Array([1, 2, 3]), { filename: "a.pdf" }).then(
      () => expect.fail("expected the upload to throw"),
      (thrown: unknown) => thrown,
    );

    expect(err).toBeInstanceOf(UploadTransportError);
    const wrapper = err as UploadTransportError;
    expect(wrapper.code).toBe("unreachable");
    expect(wrapper.cause).toBeInstanceOf(ApiUnreachableError);
    expect(wrapper.errorDomain).toBe("config");
    expect(wrapper.retryable).toBe(true);
  });
});
