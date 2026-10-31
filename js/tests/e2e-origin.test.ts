/**
 * The e2e suite's one predicate for "this origin is a hosted plane" (`tests/e2e/origin.ts`), which
 * decides whether the cases of a bare runner's routes run. Pins: every spelling of this machine is a
 * runner, every other host is a hosted plane, and a value that names no host is neither.
 */

import { describe, expect, it } from "vitest";
import { isHostedOrigin, isLoopbackHost } from "./e2e/origin.js";

describe("isLoopbackHost", () => {
  it.each(["localhost", "LOCALHOST", "api.localhost", "127.0.0.1", "127.1.2.3", "::1", "[::1]"])(
    "reads %s as this machine",
    (hostname) => {
      expect(isLoopbackHost(hostname)).toBe(true);
    },
  );

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
