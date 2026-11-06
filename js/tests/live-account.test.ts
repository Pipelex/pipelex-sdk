/**
 * The live account check (`e2e/live-account.ts`) against its shared cases,
 * `fixtures/live-account-cases.json`, which Python's e2e suite answers too, then the SDK's own
 * read of `/v1/me` and the global setup's throw.
 */

import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { PipelexApiClient } from "../src/client.js";
import { ApiResponseError } from "../src/errors.js";
import {
  JS_E2E_TARGET,
  LiveAccountRefused,
  checkLiveAccount,
  requireLiveAccount,
  sdkMeReader,
  type LiveTarget,
  type MeAnswer,
} from "./e2e/live-account.js";

interface CaseTarget {
  base_url_env: string;
  default_base_url: string | null;
  run_command: string;
}

interface Case {
  name: string;
  target: string;
  env: Record<string, string>;
  me: MeAnswer | null;
  me_at?: string;
  verdict: "no_target" | "local" | "confirmed" | "refused";
  mentions: string[];
  absent?: string[];
}

const CASES = JSON.parse(
  fs.readFileSync(new URL("./fixtures/live-account-cases.json", import.meta.url), "utf8"),
) as { targets: Record<string, CaseTarget>; cases: Case[] };

function targetOf(name: string): LiveTarget {
  const target = CASES.targets[name];
  if (target === undefined) throw new Error(`no target ${name} in the case file`);
  return {
    baseUrlEnv: target.base_url_env,
    defaultBaseUrl: target.default_base_url,
    runCommand: target.run_command,
  };
}

describe("the live account check, against its shared cases", () => {
  it.each(CASES.cases.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    const asked: { baseUrl: string; apiKey: string }[] = [];
    const verdict = await checkLiveAccount(targetOf(c.target), {
      env: c.env,
      readMe: async (request) => {
        asked.push(request);
        if (c.me === null) throw new Error("the check asked /v1/me where it must not");
        return c.me;
      },
    });

    expect(verdict.verdict).toBe(c.verdict);
    expect(asked).toHaveLength(c.me === null ? 0 : 1);
    if (c.me !== null) {
      expect(c.me_at).toBeDefined();
      expect(asked[0]).toEqual({ baseUrl: c.me_at, apiKey: c.env.PIPELEX_API_KEY });
    }
    const said = verdict.verdict === "refused" ? verdict.message : verdict.line;
    for (const mention of c.mentions) expect(said).toContain(mention);
    for (const absent of c.absent ?? []) expect(said).not.toContain(absent);
  });

  it("names the JavaScript suite's own target as the shared cases do", () => {
    expect(JS_E2E_TARGET).toEqual(targetOf("js_e2e"));
  });

  it("reports a /v1/me that gave no answer without blaming the account", async () => {
    const env = {
      PIPELEX_E2E_BASE_URL: "https://api-dev.pipelex.com",
      PIPELEX_API_KEY: "not-a-real-key",
      PIPELEX_API_KEY_EXPECTED_ORG_ID: "org_1",
      PIPELEX_API_KEY_EXPECTED_ROLE: "member",
      PIPELEX_API_KEY_EXPECTED_EMAIL: "qa+builder@example.com",
    };
    const verdict = await checkLiveAccount(JS_E2E_TARGET, {
      env,
      readMe: () => Promise.reject(new Error("connect ECONNREFUSED")),
    });

    expect(verdict.verdict).toBe("refused");
    const message = verdict.verdict === "refused" ? verdict.message : "";
    expect(message).toContain("GET /v1/me gave no answer the check can read: connect ECONNREFUSED");
    expect(message).not.toContain("The registry's owner restores the account");
  });
});

describe("the SDK's read of /v1/me", () => {
  it("answers the profile as the SDK's getMe() returns it, members it does not type included", async () => {
    const body = { email: "a@example.com", organization: { org_id: "org_1" } };
    const getMe = vi.spyOn(PipelexApiClient.prototype, "getMe").mockResolvedValue(body as never);

    await expect(
      sdkMeReader({ baseUrl: "https://api-dev.pipelex.com", apiKey: "not-a-real-key" }),
    ).resolves.toEqual({ status: 200, body });
    getMe.mockRestore();
  });

  it("throws on a 2xx it could not read, which the check reports as unreadable, never as the account", async () => {
    const unreadable = new ApiResponseError(
      "The answer to GET /v1/me could not be read",
      "https://api-dev.pipelex.com/v1/me",
      200,
      "OK",
      "not json",
    );
    const getMe = vi.spyOn(PipelexApiClient.prototype, "getMe").mockRejectedValue(unreadable);

    await expect(
      sdkMeReader({ baseUrl: "https://api-dev.pipelex.com", apiKey: "not-a-real-key" }),
    ).rejects.toBe(unreadable);
    const verdict = await checkLiveAccount(JS_E2E_TARGET, {
      env: {
        PIPELEX_E2E_BASE_URL: "https://api-dev.pipelex.com",
        PIPELEX_API_KEY: "not-a-real-key",
        PIPELEX_API_KEY_EXPECTED_ORG_ID: "org_1",
        PIPELEX_API_KEY_EXPECTED_ROLE: "member",
        PIPELEX_API_KEY_EXPECTED_EMAIL: "qa+builder@example.com",
      },
    });
    getMe.mockRestore();

    expect(verdict.verdict).toBe("refused");
    const message = verdict.verdict === "refused" ? verdict.message : "";
    expect(message).toContain("PIPELEX_API_KEY: GET /v1/me gave no answer the check can read:");
    expect(message).not.toContain("states the account");
    expect(message).not.toContain("The registry's owner restores the account");
  });

  it("answers a refusal as its status and code", async () => {
    const refusal = new ApiResponseError(
      "refused",
      "https://api-dev.pipelex.com/v1/me",
      401,
      "Unauthorized",
      JSON.stringify({ code: "auth.invalid_credential", status: 401, title: "t", detail: "d" }),
      { headers: { "content-type": "application/problem+json" } },
    );
    const getMe = vi.spyOn(PipelexApiClient.prototype, "getMe").mockRejectedValue(refusal);

    await expect(
      sdkMeReader({ baseUrl: "https://api-dev.pipelex.com", apiKey: "not-a-real-key" }),
    ).resolves.toEqual({ status: 401, body: { code: refusal.code } });
    getMe.mockRestore();
  });
});

describe("requireLiveAccount", () => {
  it("throws the refusal's message alone, so the run stops on it", async () => {
    const run = requireLiveAccount(JS_E2E_TARGET, {
      env: { PIPELEX_E2E_BASE_URL: "https://api-dev.pipelex.com" },
    });

    await expect(run).rejects.toBeInstanceOf(LiveAccountRefused);
    await expect(run).rejects.toThrow(/PIPELEX_API_KEY is not set/);
  });

  it("returns the verdict otherwise, with the base URL the cases call and as its lines show it", async () => {
    const verdict = await requireLiveAccount(JS_E2E_TARGET, {
      env: { PIPELEX_E2E_BASE_URL: "http://someone:secret-word@localhost:8081/" },
    });

    expect(verdict).toMatchObject({
      verdict: "local",
      baseUrl: "http://someone:secret-word@localhost:8081/",
      shown: "http://localhost:8081 with credentials (not shown)",
    });
    expect(verdict.line).toContain(
      "http://localhost:8081 with credentials (not shown) is a local runner",
    );
    expect(verdict.line).not.toContain("secret-word");
  });
});
