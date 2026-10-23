/**
 * Whether a request that got no answer may have left this machine, the one reading of a transport
 * failure the SDK cannot take from a problem. `ApiUnreachableError` reads it when the client tells
 * it the request may create a run, a start or a blocking execute: a failure that proves nothing was
 * sent reads as the transport's own problem (`client.unreachable`), and any other as
 * `client.outcome_unknown`, whose `retry` says the run may exist. The Python twin, `pipelex-sdk`,
 * reads the same failures the same way in `pipelex_sdk.transport_reading`.
 *
 * The reading errs on the safe side. A false "may have left" costs the person a look at the run
 * history; a false "never left" costs a second paid run. So every failure counts as one that may
 * have left unless it proves otherwise.
 */

/**
 * Whether a request that met a transport failure may have left this machine: every failure but one
 * that proves nothing was sent. `cause` is the failure fetch threw, which `ApiUnreachableError`
 * keeps as its own `cause`.
 */
export function requestMayHaveLeft(cause: unknown): boolean {
  return !provesNothingSent(cause);
}

/**
 * Whether a transport failure proves the request never left, so that no run was created by it: it
 * names a step of the connection's set-up, which no request follows. That is the name lookup or
 * the connection itself failing (the system calls `getaddrinfo` and `connect`: an unknown host, a
 * refused connection, no route to the host or the network, the system's connect time limit),
 * undici's own connect time limit, which covers the TLS handshake, and a server certificate the
 * TLS handshake refused. Several addresses each failing so, which Node reports together as an
 * `AggregateError`, prove it too. A host that drops packets is a connection that never comes:
 * undici gives it up after ten seconds (`UND_ERR_CONNECT_TIMEOUT`), before the time limit of any
 * request that may create a run, as the Python SDK meets httpx's connect timeout first and reads
 * it the same way.
 *
 * Anything else may have come once the request had left, the Python SDK reading the same failures
 * the same way. A reset (`ECONNRESET`) comes from a `read` whether the connection dropped during
 * the TLS handshake or after the request, and so does an `EHOSTUNREACH` met once connected, so
 * neither proves anything; nor does another TLS failure, which may come after the handshake; nor
 * does the SDK's own time limit (`ABORT_TIMEOUT`), which fetch cannot place before or after the
 * connection was made. Every request that
 * may create a run has a limit longer than undici's connect limit, so with Node's own dispatcher
 * it runs out only once the request has left.
 */
function provesNothingSent(fetchFailure: unknown): boolean {
  // undici gives the transport's own failure as the `cause` of fetch's.
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
  // compiles it, in its order, then its default. The Python SDK reads every
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
