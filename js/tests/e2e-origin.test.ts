/**
 * The e2e suite's one predicate for "this origin is a hosted plane" (`tests/e2e/origin.ts`), which
 * decides whether the cases of a bare runner's routes run. Pins: the loopback spellings it knows
 * (`localhost`, a subdomain of it, `127.x.x.x`, `::1`) are a runner, every other host is a hosted
 * plane, and a value that names no host is neither.
 */

import { describe, expect, it, vi } from "vitest";
import {
  OriginUnreachable,
  isHostedOrigin,
  isLoopbackHost,
  requireReachable,
} from "./e2e/origin.js";

describe("isLoopbackHost", () => {
  it.each([
    "localhost",
    "LOCALHOST",
    "api.localhost",
    "localhost.",
    "api.localhost.",
    "127.0.0.1",
    "127.1.2.3",
    "::1",
    "[::1]",
  ])("reads %s as this machine", (hostname) => {
    expect(isLoopbackHost(hostname)).toBe(true);
  });

  it.each(["api-dev.pipelex.com", "localhost.example.com", "128.0.0.1", "10.0.0.5", "::2"])(
    "reads %s as another machine",
    (hostname) => {
      expect(isLoopbackHost(hostname)).toBe(false);
    },
  );
});

describe("isHostedOrigin", () => {
  it.each([
    "http://localhost:8081",
    "http://127.0.0.1:8082/",
    "http://[::1]:8081",
    "http://api.localhost",
  ])("reads the runner at %s as no hosted plane", (baseUrl) => {
    expect(isHostedOrigin(baseUrl)).toBe(false);
  });

  it.each(["https://api-dev.pipelex.com", "https://api.pipelex.com/", "http://10.0.0.5:8081"])(
    "reads %s as a hosted plane",
    (baseUrl) => {
      expect(isHostedOrigin(baseUrl)).toBe(true);
    },
  );

  it.each(["", "localhost:8081", "not a url"])(
    "reads %j, which names no host, as no hosted plane",
    (baseUrl) => {
      expect(isHostedOrigin(baseUrl)).toBe(false);
    },
  );
});

describe("requireReachable", () => {
  it("asks /v1/version once, at the base URL without its trailing slashes, and goes ahead on a 2xx", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 200 }));

    await expect(
      requireReachable("http://localhost:8081//", "http://localhost:8081", fetchImpl),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://localhost:8081/v1/version");
  });

  it.each([
    ["an answer that is no 2xx", () => Promise.resolve(new Response("", { status: 503 }))],
    ["no answer at all", () => Promise.reject(new TypeError("fetch failed"))],
  ])("throws one message naming the URL as shown on %s", async (_name, answer) => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(answer);

    const probe = requireReachable(
      "http://someone:secret-word@localhost:8081",
      "http://localhost:8081 with credentials (not shown)",
      fetchImpl,
    );

    await expect(probe).rejects.toBeInstanceOf(OriginUnreachable);
    await expect(probe).rejects.toThrow(
      "No pipelex-api reachable at http://localhost:8081 with credentials (not shown).",
    );
  });
});
