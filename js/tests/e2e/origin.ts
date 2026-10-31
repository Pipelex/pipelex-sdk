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
 * hosted plane is: any origin whose host is not this machine. The suite's runner is a local one
 * (`make -C ../../pipelex/api run`, the default `http://localhost:8081`), and every other origin
 * it is pointed at is a deployed plane, `api-dev.pipelex.com` above all.
 */

/** Whether a URL's host is this machine: `localhost`, a subdomain of it, `127.x.x.x` or `::1`. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
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
