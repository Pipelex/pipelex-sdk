/**
 * The account a live e2e run acts for, checked once before its first case.
 *
 * Against the hosted plane, the suite acts for one registered test account: QA Builder (dev) in
 * QA SDK (dev), whose key the workspace's `test-account run` hands over in `PIPELEX_API_KEY`,
 * beside what the Pipelex team's registry of test accounts expects of it, in
 * `PIPELEX_API_KEY_EXPECTED_ORG_ID`, `PIPELEX_API_KEY_EXPECTED_ROLE` and
 * `PIPELEX_API_KEY_EXPECTED_EMAIL`. Before any case, `GET /v1/me` says who the key is, through the
 * SDK's own `getMe()`, and any difference stops the run once, naming each variable, the value
 * found and the value expected. In order, the check:
 *
 * 1. finds the base URL, and does nothing when there is none, or when it is a loopback address,
 *    a local runner or stack, which holds no registered test account; a base URL that is not an
 *    http or https URL is refused;
 * 2. refuses the production API, its host compared without case or a trailing dot, unless
 *    `PIPELEX_E2E_ALLOW_PRODUCTION=1` asks for it;
 * 3. refuses a run with no key, or with an expectation unset, before any request, naming
 *    `test-account run`;
 * 4. asks `/v1/me` and compares the account's email, ignoring case, its organization by id and its
 *    role there. A platform whose answer has no `organization` member predates it, and is reported
 *    as such, never as a pass.
 *
 * Every line and message shows the base URL as its scheme and host alone, naming any credentials,
 * path, query or fragment it carried without their text.
 *
 * Python's e2e suite runs the same check (`python/tests/e2e/live_account.py`), and both answer
 * the shared cases of `tests/fixtures/live-account-cases.json`. The page for a person is
 * `docs/live-accounts.md` at the repository's root.
 */

import { PipelexApiClient } from "../../src/client.js";
import { ApiResponseError } from "../../src/errors.js";

/** The variable holding the key the live cases act with. */
export const API_KEY_ENV = "PIPELEX_API_KEY";

/** The variable that lets a live run call the production API, when it holds exactly `1`. */
export const ALLOW_PRODUCTION_ENV = "PIPELEX_E2E_ALLOW_PRODUCTION";

/** The production API's host, which a live run calls only when asked to. */
export const PRODUCTION_HOST = "api.pipelex.com";

const ME_ROUTE = "GET /v1/me";
const DOC = "docs/live-accounts.md at the repository's root";

/**
 * What the registry expects of a key, each in the variable named after the key's with this
 * suffix. The suffixes are the workspace's `test-account run` contract.
 */
export const EXPECTATION_SUFFIXES = {
  orgId: "_EXPECTED_ORG_ID",
  role: "_EXPECTED_ROLE",
  email: "_EXPECTED_EMAIL",
} as const;

/** Where a suite's live cases go, and how a refusal tells the person to run them. */
export interface LiveTarget {
  /** The variable naming the base URL. */
  baseUrlEnv: string;
  /** The base URL when that variable is unset or empty; `null` when the live legs then skip. */
  defaultBaseUrl: string | null;
  /** The command a refusal names, the workspace's `test-account run` around the suite's target. */
  runCommand: string;
}

/** The JavaScript e2e suite's target: a local runner unless `PIPELEX_E2E_BASE_URL` names another. */
export const JS_E2E_TARGET: LiveTarget = {
  baseUrlEnv: "PIPELEX_E2E_BASE_URL",
  defaultBaseUrl: "http://localhost:8081",
  runCommand: "test-account run pipelex-sdk-js-e2e -- make -C js test-e2e",
};

/** What `GET /v1/me` answered: its HTTP status and its JSON body. */
export interface MeAnswer {
  status: number;
  body: unknown;
}

/** Reads `/v1/me` with a key; injected by the unit tests. */
export type MeReader = (request: { baseUrl: string; apiKey: string }) => Promise<MeAnswer>;

/** The check's verdict, with the line or the one message it reports. */
export type LiveAccountVerdict =
  | { verdict: "no_target"; line: string }
  | { verdict: "local"; line: string }
  | { verdict: "confirmed"; line: string }
  | { verdict: "refused"; message: string };

type Env = Readonly<Record<string, string | undefined>>;

/** A value as a finding renders it: as JSON, a missing one as `null`. */
function rendered(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectationVariable(suffix: string): string {
  return `${API_KEY_ENV}${suffix}`;
}

/** "A is", "A and B are", "A, B and C are". */
function listed(names: readonly string[]): string {
  if (names.length === 1) return `${names[0]} is`;
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)} are`;
}

/** Whether a host is this machine: `localhost`, a subdomain of it, `127.x.x.x` or `::1`. */
function isLoopback(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

/** "A", "A and B", "A, B and C". */
function inWords(parts: readonly string[]): string {
  if (parts.length === 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** A base URL the check can call, as it compares it and as its lines show it. */
interface ParsedBaseUrl {
  /**
   * The host as the check compares it: lowercased, without the brackets of an IPv6 address, and
   * without the trailing dot that names the same host to DNS, so `https://api.pipelex.com.` is
   * the production API too.
   */
  host: string;
  /**
   * The base URL as a line or a message shows it: its scheme and its host, then the names of the
   * parts beyond them it carried, never their text, as the SDK's own refusal of a base URL shows
   * one (`describeRefusedBaseUrl` in `src/client.ts`). Credentials, a path and a query are where a
   * secret travels in a URL, and these lines reach a terminal or a CI log.
   */
  shown: string;
}

/** The base URL, or `null` when it is not an http or https URL with a host. */
function parseBaseUrl(baseUrl: string): ParsedBaseUrl | null {
  let url: URL;
  try {
    // Trailing slashes are stripped first, as the client strips them (`src/client.ts`).
    url = new URL(baseUrl.replace(/\/+$/, ""));
  } catch {
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname === "") {
    return null;
  }
  const host = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
  const parts: string[] = [];
  if (url.username !== "" || url.password !== "") parts.push("credentials");
  if (url.pathname !== "/" && url.pathname !== "") parts.push("a path");
  if (url.search !== "") parts.push("a query");
  if (url.hash !== "") parts.push("a fragment");
  const origin = `${url.protocol}//${url.host}`;
  return {
    host,
    shown: parts.length === 0 ? origin : `${origin} with ${inWords(parts)} (not shown)`,
  };
}

/** One reason the account could not be confirmed, and whether only the registry's owner restores it. */
interface Finding {
  text: string;
  ownerRestores: boolean;
}

/** Compare a `/v1/me` answer with what the registry expects of the key. */
function readAccount(
  answer: MeAnswer,
  expected: { orgId: string; role: string; email: string },
): { findings: Finding[]; confirmed: string } {
  const orgVar = expectationVariable(EXPECTATION_SUFFIXES.orgId);
  const roleVar = expectationVariable(EXPECTATION_SUFFIXES.role);
  const emailVar = expectationVariable(EXPECTATION_SUFFIXES.email);
  if (answer.status !== 200) {
    const code = isRecord(answer.body) ? answer.body.code : undefined;
    const named = typeof code === "string" && code !== "" ? ` (${code})` : "";
    return {
      findings: [
        {
          text: `${API_KEY_ENV}: ${ME_ROUTE} refused the key: HTTP ${answer.status}${named}`,
          ownerRestores: true,
        },
      ],
      confirmed: "",
    };
  }
  const body = answer.body;
  if (!isRecord(body)) {
    return {
      findings: [
        {
          text: `${API_KEY_ENV}: ${ME_ROUTE} answered ${rendered(body)}, not a profile`,
          ownerRestores: false,
        },
      ],
      confirmed: "",
    };
  }

  const findings: Finding[] = [];
  const email = body.email;
  if (typeof email !== "string" || email.toLowerCase() !== expected.email.toLowerCase()) {
    findings.push({
      text: `${API_KEY_ENV}: ${ME_ROUTE} states the account ${rendered(email)}, where ${emailVar} expects ${rendered(expected.email)}`,
      ownerRestores: true,
    });
  }
  if (!("organization" in body)) {
    findings.push({
      text: `${API_KEY_ENV}: the platform does not state the key's organization yet, so its organization and role cannot be compared with ${orgVar} and ${roleVar}`,
      ownerRestores: false,
    });
    return { findings, confirmed: "" };
  }
  const organization = body.organization;
  if (!isRecord(organization)) {
    findings.push({
      text: `${API_KEY_ENV}: ${ME_ROUTE} states the key acts for no organization, where ${orgVar} expects ${rendered(expected.orgId)}`,
      ownerRestores: true,
    });
    return { findings, confirmed: "" };
  }

  const { name, org_id: orgId, role_in_org: role } = organization;
  const label =
    typeof name === "string" && name !== "" ? `${name} (${String(orgId)})` : rendered(orgId);
  if (orgId !== expected.orgId) {
    findings.push({
      text: `${API_KEY_ENV}: ${ME_ROUTE} states the organization ${label}, where ${orgVar} expects ${rendered(expected.orgId)}`,
      ownerRestores: true,
    });
  }
  if (role !== expected.role) {
    findings.push({
      text: `${API_KEY_ENV}: ${ME_ROUTE} states the role ${rendered(role)} in ${label}, where ${roleVar} expects ${rendered(expected.role)}`,
      ownerRestores: true,
    });
  }
  return { findings, confirmed: `${API_KEY_ENV} acts for ${label} as ${String(role)}` };
}

/** The one message a run stops with when its account could not be confirmed. */
function stopMessage(
  shownBaseUrl: string,
  findings: readonly Finding[],
  target: LiveTarget,
): string {
  const lines = [
    `The live cases did not start: the account ${API_KEY_ENV} acts for at ${shownBaseUrl} could not be confirmed as the one the registry of test accounts expects.`,
    ...findings.map((finding) => `- ${finding.text}`),
  ];
  if (findings.some((finding) => finding.ownerRestores)) {
    lines.push(
      "The registry's owner restores the account; never change the key or its expectations to get past this.",
    );
  }
  lines.push(
    `On a laptop, run the live cases through the workspace's \`${target.runCommand}\` (${DOC}).`,
  );
  return lines.join("\n");
}

/** The SDK's own read of `/v1/me`: its body on a 2xx, the refusal's status and code otherwise. */
export const sdkMeReader: MeReader = async ({ baseUrl, apiKey }) => {
  const client = new PipelexApiClient({ baseUrl, apiKey });
  try {
    return { status: 200, body: await client.getMe() };
  } catch (err) {
    if (err instanceof ApiResponseError) {
      return { status: err.status, body: { code: err.code } };
    }
    throw err;
  }
};

export interface LiveAccountOptions {
  env?: Env;
  readMe?: MeReader;
}

/**
 * Check the account a live run acts for against the expectations its environment carries.
 * Nothing is sent before the base URL, the production gate, the key and the expectations hold.
 */
export async function checkLiveAccount(
  target: LiveTarget,
  options: LiveAccountOptions = {},
): Promise<LiveAccountVerdict> {
  const env = options.env ?? process.env;
  const readMe = options.readMe ?? sdkMeReader;

  const named = env[target.baseUrlEnv]?.trim() || undefined;
  const baseUrl = named ?? target.defaultBaseUrl ?? undefined;
  if (baseUrl === undefined) {
    return {
      verdict: "no_target",
      line: `${target.baseUrlEnv} is not set, so the live legs skip and no account is checked.`,
    };
  }

  const parsed = parseBaseUrl(baseUrl);
  if (parsed === null) {
    return {
      verdict: "refused",
      message: `The live cases did not start: ${target.baseUrlEnv} is not an http or https URL, so no request was sent. Its value is not shown, since nothing says which of its characters are a secret.`,
    };
  }
  const { host, shown } = parsed;
  if (isLoopback(host)) {
    return {
      verdict: "local",
      line: `${shown} is a local runner, which holds no registered test account, so the live cases run without an account check.`,
    };
  }

  if (host === PRODUCTION_HOST && env[ALLOW_PRODUCTION_ENV] !== "1") {
    const where =
      named === undefined
        ? `${target.baseUrlEnv} is not set, so the live cases would call the production API, ${shown},`
        : `${target.baseUrlEnv} names the production API, ${shown},`;
    return {
      verdict: "refused",
      message:
        `The live cases did not start: ${where} which they call only when ${ALLOW_PRODUCTION_ENV}=1 asks for it, so no request was sent. ` +
        `Run them through the workspace's \`${target.runCommand}\`, which points them at the dev plane (${DOC}).`,
    };
  }

  const apiKey = env[API_KEY_ENV] || undefined;
  if (apiKey === undefined) {
    return {
      verdict: "refused",
      message:
        `The live cases did not start: ${shown} is a hosted plane and ${API_KEY_ENV} is not set, so no request was sent. ` +
        `Run them through the workspace's \`${target.runCommand}\`, which hands over the key of the test account they act for beside what the registry expects of it (${DOC}).`,
    };
  }

  const variables = Object.values(EXPECTATION_SUFFIXES).map(expectationVariable);
  const missing = variables.filter((variable) => !env[variable]);
  if (missing.length > 0) {
    return {
      verdict: "refused",
      message:
        `The live cases did not start: ${listed(missing)} not set, so nothing says which account ${API_KEY_ENV} must act for, and no request was sent. ` +
        `Run them through the workspace's \`${target.runCommand}\`, which hands over the key beside what the registry of test accounts expects of it; a CI job sets the same variables from the registry (${DOC}).`,
    };
  }
  const expected = {
    orgId: env[expectationVariable(EXPECTATION_SUFFIXES.orgId)] ?? "",
    role: env[expectationVariable(EXPECTATION_SUFFIXES.role)] ?? "",
    email: env[expectationVariable(EXPECTATION_SUFFIXES.email)] ?? "",
  };

  let answer: MeAnswer;
  try {
    answer = await readMe({ baseUrl, apiKey });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const finding = {
      text: `${API_KEY_ENV}: ${ME_ROUTE} gave no answer: ${reason}`,
      ownerRestores: false,
    };
    return { verdict: "refused", message: stopMessage(shown, [finding], target) };
  }

  const reading = readAccount(answer, expected);
  if (reading.findings.length > 0) {
    return { verdict: "refused", message: stopMessage(shown, reading.findings, target) };
  }
  return {
    verdict: "confirmed",
    line: `${reading.confirmed} at ${shown}, as the registry of test accounts expects.`,
  };
}

/**
 * Raised when the live account is refused. Its message is the whole report, so its stack is that
 * message alone: the frames of the check say nothing the message does not.
 */
export class LiveAccountRefused extends Error {
  override name = "LiveAccountRefused";

  constructor(message: string) {
    super(message);
    this.stack = `${this.name}: ${message}`;
  }
}

/** {@link checkLiveAccount}, throwing its message on a refusal and returning its line otherwise. */
export async function requireLiveAccount(
  target: LiveTarget,
  options: LiveAccountOptions = {},
): Promise<string> {
  const verdict = await checkLiveAccount(target, options);
  if (verdict.verdict === "refused") {
    throw new LiveAccountRefused(verdict.message);
  }
  return verdict.line;
}
