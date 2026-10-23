/**
 * The problems this SDK reads and builds, pinned by the case file both SDKs share,
 * `fixtures/sdk-problems.json`: the reading of an answer that is not the route's result, the
 * readings of a storage status and of each transfer failure's reason, and the problem each error
 * class carries when its raise site states none. The Python SDK runs the same file
 * (`python/tests/unit/test_sdk_problems.py`).
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { ProblemError, isProblem } from "mthds/protocol";
import type { Problem } from "mthds/protocol";

import { readHostedAnswer } from "../src/answer-reading.js";
import {
  ApiUnreachableError,
  ArtifactFetchError,
  ArtifactOperationError,
  InputPreparationError,
  InvalidInputValueError,
  InvalidLocalSourceError,
  MethodLoadError,
  MissingMainStuffError,
  PagingNotTerminatingError,
  PipelineExecuteTimeoutError,
  RequestArgumentError,
  RunLifecycleUnavailableError,
  RunStillRunningError,
  RunTimeoutError,
  ScopeUnavailableError,
  UnsupportedUploadCapabilityError,
  UploadAuthenticationError,
  UploadNotAllowedError,
  artifactFetchProblem,
  methodFileTransferProblem,
  storageStatusProblem,
  uploadTransportProblem,
} from "../src/errors.js";
import type { MethodFileTransferReason, UploadTransportReason } from "../src/errors.js";

interface AnswerCase {
  name: string;
  summary: string;
  creates_run: boolean;
  status: number;
  headers: Record<string, string>;
  body?: unknown;
  text?: string;
  expect: {
    code: string;
    from_body: boolean;
    retry: string;
    status?: number;
    retry_after?: number;
    pipeline_run_id?: string;
    request_id?: string;
    run_error_code?: string;
  };
}

interface ClassCase {
  class: string;
  summary: string;
  code: string;
  retry?: string;
  params?: Record<string, unknown>;
  pipeline_run_id?: string;
}

interface CaseFile {
  answers: AnswerCase[];
  storage_statuses: { status: number; code: string }[];
  upload_transport: { reason: UploadTransportReason | null; status: number | null; code: string }[];
  artifact_fetch: { reason: string; status: number | null; code: string }[];
  method_file_transfer: {
    reason: MethodFileTransferReason;
    status: number | null;
    code: string;
  }[];
  classes: ClassCase[];
}

const CASES = JSON.parse(
  readFileSync(new URL("./fixtures/sdk-problems.json", import.meta.url), "utf8"),
) as CaseFile;

/** A fetch failure whose transport failure proves nothing was sent: a refused connection. */
function refusedConnection(): TypeError {
  const system = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), {
    code: "ECONNREFUSED",
    syscall: "connect",
  });
  return new TypeError("fetch failed", { cause: system });
}

/** A fetch failure after the request may have left: a connection reset while reading. */
function resetConnection(): TypeError {
  const system = Object.assign(new Error("read ECONNRESET"), {
    code: "ECONNRESET",
    syscall: "read",
  });
  return new TypeError("fetch failed", { cause: system });
}

/** Each class of the case file, built from the arguments it takes. */
const BUILDERS: Record<string, () => ProblemError> = {
  RequestArgumentError: () => new RequestArgumentError("refused"),
  InputPreparationError: () => new InputPreparationError("refused"),
  InvalidLocalSourceError: () => new InvalidLocalSourceError("unreadable", "receipt.pdf"),
  InvalidInputValueError: () =>
    new InvalidInputValueError("not a file", { inputName: "receipt", inputPath: "receipt" }),
  UploadNotAllowedError: () =>
    new UploadNotAllowedError({
      inputName: "receipt",
      inputPath: "receipt",
      valueKind: "local_path",
    }),
  MethodLoadError: () => new MethodLoadError("does not load", { errors: [] }),
  UnsupportedUploadCapabilityError: () => new UnsupportedUploadCapabilityError("no upload"),
  UploadAuthenticationError: () => new UploadAuthenticationError("refused", 401),
  PipelineExecuteTimeoutError: () => new PipelineExecuteTimeoutError(31_000),
  MissingMainStuffError: () => new MissingMainStuffError("no main stuff", "run-1"),
  RunTimeoutError: () => new RunTimeoutError("timed out", "run-1", 1_000),
  RunStillRunningError: () => new RunStillRunningError("still running", "run-1"),
  RunLifecycleUnavailableError: () =>
    new RunLifecycleUnavailableError("no lifecycle", "https://api.example.com"),
  PagingNotTerminatingError: () => new PagingNotTerminatingError("never ends", 1_000),
  ArtifactOperationError: () => new ArtifactOperationError("failed"),
  ScopeUnavailableError: () => new ScopeUnavailableError("main_stuff", "run-1"),
  "ApiUnreachableError/unreachable": () =>
    new ApiUnreachableError("no answer", "https://api.example.com", "ECONNRESET", {
      cause: resetConnection(),
    }),
  "ApiUnreachableError/timeout": () =>
    new ApiUnreachableError("timed out", "https://api.example.com", "ABORT_TIMEOUT", {
      timeoutMs: 20_000,
    }),
  "ApiUnreachableError/start-may-have-left": () =>
    new ApiUnreachableError("no answer", "https://api.example.com", "ECONNRESET", {
      cause: resetConnection(),
      mayStartRun: true,
    }),
  "ApiUnreachableError/start-nothing-sent": () =>
    new ApiUnreachableError("refused", "https://api.example.com", "ECONNREFUSED", {
      cause: refusedConnection(),
      mayStartRun: true,
    }),
};

/** The case's answer body, as the text it came as. */
function bodyText(answer: AnswerCase): string {
  if (answer.text !== undefined) return answer.text;
  return JSON.stringify(answer.body);
}

describe("sdk-problems.json", () => {
  describe("answers", () => {
    it.each(CASES.answers.map((answer) => [answer.name, answer] as const))(
      "%s",
      (_name, answer) => {
        const reading = readHostedAnswer(
          { status: answer.status, headers: answer.headers, body: bodyText(answer) },
          { createsRun: answer.creates_run },
        );
        const { problem } = reading;
        expect(isProblem(problem)).toBe(true);
        expect(problem.code).toBe(answer.expect.code);
        expect(reading.fromBody).toBe(answer.expect.from_body);
        expect(problem.retry).toBe(answer.expect.retry);
        if (answer.expect.status !== undefined) expect(problem.status).toBe(answer.expect.status);
        expect(problem.retry_after).toBe(answer.expect.retry_after);
        expect(problem.pipeline_run_id).toBe(answer.expect.pipeline_run_id);
        if (answer.expect.request_id !== undefined) {
          expect(problem.request_id).toBe(answer.expect.request_id);
        }
        if (answer.expect.run_error_code !== undefined) {
          expect((problem.run_error as Problem).code).toBe(answer.expect.run_error_code);
        }
      },
    );
  });

  it.each(CASES.storage_statuses.map((entry) => [entry.status, entry.code] as const))(
    "a storage answer of %s reads as %s",
    (status, code) => {
      expect(storageStatusProblem(status).code).toBe(code);
    },
  );

  it.each(CASES.upload_transport.map((entry) => [entry.reason, entry.status, entry.code] as const))(
    "an upload transport failure %s with the status %s carries %s",
    (reason, status, code) => {
      expect(uploadTransportProblem(reason ?? undefined, status ?? undefined).code).toBe(code);
    },
  );

  it.each(CASES.artifact_fetch.map((entry) => [entry.reason, entry.status, entry.code] as const))(
    "an artifact fetch failure %s with the status %s carries %s",
    (reason, status, code) => {
      const uri = "pipelex-storage://org/file.pdf";
      expect(artifactFetchProblem(reason, uri, status ?? undefined).code).toBe(code);
      expect(new ArtifactFetchError("failed", uri, reason, status ?? undefined).code).toBe(code);
    },
  );

  it.each(
    CASES.method_file_transfer.map((entry) => [entry.reason, entry.status, entry.code] as const),
  )("a method file transfer failure %s with the status %s carries %s", (reason, status, code) => {
    expect(methodFileTransferProblem(reason, status ?? undefined).code).toBe(code);
  });

  describe("classes", () => {
    it("names a builder for every class of the case file, and a case for every builder", () => {
      expect(Object.keys(BUILDERS).sort()).toEqual(
        CASES.classes.map((entry) => entry.class).sort(),
      );
    });

    it.each(CASES.classes.map((entry) => [entry.class, entry] as const))("%s", (name, entry) => {
      const error = BUILDERS[name]!();
      expect(error).toBeInstanceOf(ProblemError);
      expect(isProblem(error.problem)).toBe(true);
      expect(error.code).toBe(entry.code);
      if (entry.retry !== undefined) expect(error.retry).toBe(entry.retry);
      if (entry.params !== undefined) expect(error.problem.params).toEqual(entry.params);
      if (entry.pipeline_run_id !== undefined) {
        expect(error.problem.pipeline_run_id).toBe(entry.pipeline_run_id);
      }
    });
  });
});
