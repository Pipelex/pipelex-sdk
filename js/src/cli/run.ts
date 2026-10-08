/**
 * `pipelex-sdk run`: run one method and print its main output.
 *
 * Every check that needs no request comes first, in this order, so that a mistake costs nothing:
 * the flags, `--pipe`'s form, the method (a path is read from disk), the inputs, the poll interval
 * and the key. Then the inputs are prepared, which uploads each local file at a file input; the
 * run is started through the SDK's start-and-wait, whose `onStarted` gives the run id to stderr
 * as soon as the run exists; and the main output reaches stdout once the run completes, however
 * long that takes.
 */

import {
  ApiResponseError,
  ApiUnreachableError,
  MissingMainStuffError,
  PipelineExecuteTimeoutError,
  RunFailedError,
  isGatewayCutOff,
  renderInputsTemplate,
} from "../index.js";
import type { PipelexApiClient, RunResults } from "../index.js";
import { parseFlags } from "./args.js";
import { readBundle } from "./bundle.js";
import { makeClient, readPollInterval } from "./environment.js";
import { RUN_HELP } from "./help.js";
import { readInputs } from "./inputs.js";
import {
  CommandError,
  EXIT_INTERRUPTED,
  EXIT_OK,
  Interrupted,
  untilInterrupted,
  usageError,
  writeLines,
} from "./io.js";
import type { CommandIO } from "./io.js";
import { checkPipeRef, classifyMethod } from "./method.js";
import { presentError, printResult } from "./present.js";
import { crateSelector, describePipe, runSelector } from "./source.js";
import type { MethodSource } from "./source.js";

const RUN_FLAGS = {
  method: { type: "string" },
  pipe: { type: "string" },
  inputs: { type: "string" },
  "inputs-template": { type: "boolean" },
} as const;

/**
 * Where a run stands, which decides what an interrupt and a failure say. `since` is when the
 * request that may create a run left, on the clock the SDK times its requests with (`Date.now`).
 */
type Stage =
  | { readonly kind: "local" }
  | { readonly kind: "starting"; readonly since: number }
  | { readonly kind: "started"; readonly runId: string };

/** Run `pipelex-sdk run` and return its exit code. */
export async function runCommandRun(args: readonly string[], io: CommandIO): Promise<number> {
  const flags = parseFlags("run", args, RUN_FLAGS);
  if (flags.help) {
    io.writeStdout(RUN_HELP);
    return EXIT_OK;
  }
  const method = flags.strings.get("method");
  if (method === undefined) {
    throw usageError("--method is required.", ["Run 'pipelex-sdk run --help' to see its flags."]);
  }
  const inputsSource = flags.strings.get("inputs");
  const templateOnly = flags.booleans.has("inputs-template");
  if (templateOnly && inputsSource !== undefined) {
    throw usageError("--inputs-template prints the inputs a run takes, so it takes no --inputs.");
  }
  const pipe = flags.strings.get("pipe");
  if (pipe !== undefined) checkPipeRef(pipe);

  let stage: Stage = { kind: "local" };
  try {
    // Raced like the inputs read: a bundle on a stalled mount must not hold the command.
    const source = await untilInterrupted(() => methodSource(method), io.interrupt);
    const inputs = inputsSource === undefined ? undefined : await readInputs(inputsSource, io);
    const intervalMs = readPollInterval(io);
    const client = makeClient(io);

    if (templateOnly) {
      const described = await describePipe(client, source, pipe, io.interrupt);
      const template = renderInputsTemplate(described.descriptor, {
        explicit: false,
        format: "json",
      });
      io.writeStdout(`${template}\n`);
      return EXIT_OK;
    }

    const prepared = await prepare(client, source, pipe, inputs, io);
    const results: RunResults = await untilInterrupted(() => {
      return client.startAndWaitForResult(
        {
          ...runSelector(source),
          ...(pipe === undefined ? {} : { pipe_code: pipe }),
          ...(prepared === undefined ? {} : { inputs: prepared }),
        },
        {
          // A run takes as long as it takes: the command waits for it until it ends or the
          // person interrupts.
          timeoutMs: Number.POSITIVE_INFINITY,
          ...(intervalMs === undefined ? {} : { intervalMs }),
          signal: io.interrupt,
          artifacts: ["main_stuff"],
          onStarting: () => {
            // Only once a request that may create a run is about to leave: an interrupt before
            // it, during the version handshake included, starts nothing, and the command says so.
            stage = { kind: "starting", since: Date.now() };
          },
          onStarted: (ack) => {
            if (io.interrupt.aborted) return;
            stage = { kind: "started", runId: ack.pipeline_run_id };
            io.writeStderr(`Run started: ${ack.pipeline_run_id}\n`);
          },
        },
      );
    }, io.interrupt);
    printResult(results.main_stuff, io);
    return EXIT_OK;
  } catch (error) {
    if (!(error instanceof Interrupted)) {
      const runId = waitedOnRun(stage, error);
      const warning =
        runId !== undefined
          ? runStillGoingLine(runId)
          : mayHaveStarted(stage, error)
            ? RUN_MAY_HAVE_STARTED_LINE
            : undefined;
      if (warning === undefined) throw error;
      // A failure that says nothing of a run that exists, or may: a wrapper must not read it as a
      // failed run and pay for another.
      const presented = presentError(error);
      writeLines(io, [...presented.lines, warning]);
      return presented.exitCode;
    }
    throw new CommandError(interruptMessage(stage, templateOnly), {
      exitCode: EXIT_INTERRUPTED,
      bare: true,
    });
  }
}

/**
 * The run a failure leaves going on the server: the run that exists when the failure is not its
 * own outcome, a failed run or a completed one without its output, but an unreachable API or a
 * refused poll.
 */
function waitedOnRun(stage: Stage, error: unknown): string | undefined {
  if (stage.kind !== "started") return undefined;
  if (error instanceof RunFailedError || error instanceof MissingMainStuffError) return undefined;
  return stage.runId;
}

/**
 * Whether a transport failure proves the request never left, so that no run was created by it: it
 * names a step of the connection's set-up, which no request follows. That is the name lookup or
 * the connection itself failing (the system calls `getaddrinfo` and `connect`: an unknown host, a
 * refused connection, no route to the host or the network, the system's connect time limit),
 * undici's own connect time limit, and a server certificate the TLS handshake refused. Several
 * addresses each failing so, which Node reports together as an `AggregateError`, prove it too.
 *
 * Anything else may have come once the request had left, the Python command reading the same
 * failures the same way. A reset (`ECONNRESET`) comes from a `read` whether the connection dropped
 * during the TLS handshake or after the request, and so does an `EHOSTUNREACH` met once connected,
 * so neither proves anything; nor does another TLS failure, which may come after the handshake;
 * nor does the SDK's own time limit (`ABORT_TIMEOUT`), which fetch cannot place before or after
 * the connection was made: a limit shorter than undici's ten-second connect limit can run out
 * before it, while the request waits for no connection at all. The Python command, whose httpx
 * does tell that phase, reads its own connect and pool timeouts as a run that may exist too.
 */
function provesNothingSent(error: ApiUnreachableError): boolean {
  // The SDK keeps fetch's own failure as `cause`, and undici gives the transport's under it.
  const fetchFailure = error.cause;
  return fetchFailure instanceof Error && isConnectionSetupFailure(fetchFailure.cause);
}

function isConnectionSetupFailure(failure: unknown): boolean {
  if (failure instanceof AggregateError) {
    return failure.errors.length > 0 && failure.errors.every(isConnectionSetupFailure);
  }
  if (typeof failure !== "object" || failure === null) return false;
  const { code, syscall } = failure as { code?: unknown; syscall?: unknown };
  if (typeof code === "string" && CONNECTION_SETUP_CODES.has(code)) return true;
  return typeof syscall === "string" && CONNECTION_SETUP_CALLS.has(syscall);
}

/** The system calls that resolve the host's name and open the connection. */
const CONNECTION_SETUP_CALLS: ReadonlySet<string> = new Set(["getaddrinfo", "connect"]);

/**
 * The codes only a step of the connection's set-up gives: the name lookup's and the connect call's
 * own (set even where Node reports several addresses together, without a system call), undici's
 * connect time limit, Node's limit on one attempt among several addresses, Node's own check of the
 * host's name, and every code Node gives a server certificate the TLS handshake refused.
 */
const CONNECTION_SETUP_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "ERR_SOCKET_CONNECTION_TIMEOUT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_TLS_CERT_ALTNAME_FORMAT",
  // Node names the verdicts of OpenSSL's certificate check from a fixed table, the "X509 certificate
  // error codes" of its `tls` docs, and gives every other verdict, such as an unhandled critical
  // extension or a CA certificate that may not sign certificates, the code `UNSPECIFIED`. The
  // error carries nothing else that marks it, so these codes are the mark: the table as Node 24
  // compiles it, in its order, then its default. The Python command reads every
  // `ssl.SSLCertVerificationError` the same way.
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_CRL",
  "UNABLE_TO_DECRYPT_CERT_SIGNATURE",
  "UNABLE_TO_DECRYPT_CRL_SIGNATURE",
  "UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY",
  "CERT_SIGNATURE_FAILURE",
  "CRL_SIGNATURE_FAILURE",
  "CERT_NOT_YET_VALID",
  "CERT_HAS_EXPIRED",
  "CRL_NOT_YET_VALID",
  "CRL_HAS_EXPIRED",
  "ERROR_IN_CERT_NOT_BEFORE_FIELD",
  "ERROR_IN_CERT_NOT_AFTER_FIELD",
  "ERROR_IN_CRL_LAST_UPDATE_FIELD",
  "ERROR_IN_CRL_NEXT_UPDATE_FIELD",
  "OUT_OF_MEM",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_CHAIN_TOO_LONG",
  "CERT_REVOKED",
  "INVALID_CA",
  "PATH_LENGTH_EXCEEDED",
  "INVALID_PURPOSE",
  "CERT_UNTRUSTED",
  "CERT_REJECTED",
  "HOSTNAME_MISMATCH",
  "UNSPECIFIED",
]);

/**
 * Whether a failure met once a request that may create a run was sent, and before the API named
 * the run, leaves it unknown whether one was created: its answer was lost to a time limit, a
 * connection that closed once the request had left or a gateway that cut the request off, or it
 * came back unreadable, or a gateway answered that it lost or never got the server's answer
 * (`502`, `504`, RFC 9110). A gateway cuts a request off at ~30 seconds, whether a blocking
 * execute or a start the server is still handling, such as one fetching a `method_ref`'s package:
 * the SDK's `isGatewayCutOff` tells it, past its threshold, from the time since `onStarting`. Any
 * other answer from the API, a `503` that came back before that saying the request was not handled
 * included, and a failure that proves nothing was sent, say no run was created.
 */
function mayHaveStarted(stage: Stage, error: unknown): boolean {
  if (stage.kind !== "starting") return false;
  if (error instanceof PipelineExecuteTimeoutError) return true;
  if (error instanceof ApiUnreachableError) return !provesNothingSent(error);
  if (!(error instanceof ApiResponseError)) return false;
  if (error.status >= 200 && error.status < 300) return true;
  return GATEWAY_LOST_ANSWER.has(error.status) || isGatewayCutOff(error, Date.now() - stage.since);
}

/** The gateway statuses that say the server's answer was lost or never came (RFC 9110). */
const GATEWAY_LOST_ANSWER: ReadonlySet<number> = new Set([502, 504]);

/** The line under a failure that leaves it unknown whether a run was created. */
export const RUN_MAY_HAVE_STARTED_LINE =
  "A run may have started on the server without the command learning of it, so check before starting it again.";

/** The line under a failure met while waiting on a run that exists. */
export function runStillGoingLine(runId: string): string {
  return `Run ${runId} may still be going on the server, so do not start it again.`;
}

/** The method `--method` names, a path being read from disk. */
async function methodSource(method: string): Promise<MethodSource> {
  const selector = classifyMethod(method);
  switch (selector.kind) {
    case "address":
      return { kind: "address", methodRef: selector.methodRef };
    case "catalog":
      return { kind: "catalog", methodId: selector.methodId };
    case "path":
      return { kind: "bundle", files: await readBundle(selector.path) };
  }
}

/**
 * Upload the local files the inputs name at the method's file inputs, through the SDK's input
 * preparation, and report each upload on stderr. Inputs that are absent or empty are sent as they
 * are, with no request: there is nothing to upload.
 */
async function prepare(
  client: PipelexApiClient,
  source: MethodSource,
  pipe: string | undefined,
  inputs: Record<string, unknown> | undefined,
  io: CommandIO,
): Promise<Record<string, unknown> | undefined> {
  if (inputs === undefined || Object.keys(inputs).length === 0) return inputs;
  const prepared = await untilInterrupted(
    () =>
      client.prepareInputs({
        ...crateSelector(source),
        ...(pipe === undefined ? {} : { pipe_ref: pipe }),
        inputs,
        // Once interrupted, no upload starts after the pipe I/O answer arrives.
        signal: io.interrupt,
      }),
    io.interrupt,
  );
  for (const upload of prepared.uploads) {
    io.writeStderr(`Uploaded ${upload.filename} as ${upload.uri}\n`);
  }
  return prepared.inputs;
}

/** What an interrupt says, by where the run stood. */
function interruptMessage(stage: Stage, templateOnly: boolean): string {
  if (templateOnly) return "Interrupted.";
  switch (stage.kind) {
    case "local":
      return "Interrupted. No run was started.";
    case "starting":
      return "Interrupted before the API answered with a run id. A run may or may not have started on the server.";
    case "started":
      return `Interrupted. Run ${stage.runId} keeps going on the server.`;
  }
}
