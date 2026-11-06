/**
 * Which kind of origin the e2e suite calls: a bare runner on this machine, or a hosted plane.
 *
 * Some cases exercise routes only a bare runner serves. `lint` and `format` are `pipelex-api`
 * routes the hosted plane does not expose: neither its gateway's API-key allowlist nor its
 * platform's tooling proxy lists them, so a hosted origin answers both with the gateway's bare
 * `403 {"message":"Forbidden"}` before any service sees the request (`docs/crate-routes.md`, and
 * L-260929-b58f26, which decides whether the hosted plane will serve them). Those cases skip on a
 * hosted origin, as the `method_id` cases skip when no stored method is named, rather than fail on
 * a refusal that says nothing about the SDK.
 *
 * Every file decides it through this one predicate, so the suite agrees with itself on what a
 * hosted plane is: any origin whose host is not one of the loopback spellings `isLoopbackHost`
 * knows. Another spelling of this machine, such as `0.0.0.0` or an IPv4-mapped `::ffff:127.0.0.1`,
 * reads as hosted and skips the runner-only cases. The suite's runner is a local one
 * (`make -C ../../pipelex/api run`, the default `http://localhost:8081`), and every other origin
 * it is pointed at is a deployed plane, `api-dev.pipelex.com` above all.
 */

/**
 * Whether a URL's host is this machine: `localhost`, a subdomain of it, `127.x.x.x` or `::1`. The
 * host is compared without case, the brackets of an IPv6 address, or the trailing dot that names
 * the same host to DNS, so `localhost.` is this machine too.
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

/**
 * Whether `baseUrl` names a hosted plane rather than a runner on this machine. A value that is not
 * a URL, or one with no host such as `localhost:8081` (read as a scheme), names neither, so it is
 * not hosted, and the suite's reachability check reports it.
 */
export function isHostedOrigin(baseUrl: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname;
  } catch {
    return false;
  }
  return hostname !== "" && !isLoopbackHost(hostname);
}

/**
 * Raised when the suite's origin answers nothing. Its message is the whole report, so its stack is
 * that message alone, as `LiveAccountRefused`'s is (`live-account.ts`).
 */
export class OriginUnreachable extends Error {
  override name = "OriginUnreachable";

  constructor(message: string) {
    super(message);
    this.stack = `${this.name}: ${message}`;
  }
}

/** How long the reachability probe waits for `/v1/version` before it reports the origin down. */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * Probe the origin once, before the first case, and throw one message when it answers nothing,
 * instead of letting every file's `beforeAll` fail on it and print a socket error each. It reads
 * `/v1/version`, deliberately: a bare runner serves the origin-level `/health` and a hosted origin
 * does not, so `/v1/version` is the one unauthenticated route both answer. The global setup runs it
 * after the account check (`live-account.ts`), so a refused run sends nothing at all, and `shown`
 * is the URL as that check shows it, never with the credentials, path or query it may carry.
 */
export async function requireReachable(
  baseUrl: string,
  shown: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  let reachable: boolean;
  try {
    const answer = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/v1/version`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    reachable = answer.ok;
  } catch {
    reachable = false;
  }
  if (!reachable) {
    throw new OriginUnreachable(
      `No pipelex-api reachable at ${shown}. Start one with make -C ../../pipelex/api run, the runner in the workspace's pipelex checkout, or point PIPELEX_E2E_BASE_URL (shell or .env) at a running instance.`,
    );
  }
}
