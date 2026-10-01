import { describe, it, expect, vi, beforeEach } from "vitest";

const execute = vi.fn();
const start = vi.fn();
const getRunStatus = vi.fn();
const getRunResult = vi.fn();

vi.mock("@/lib/pipelexClient", () => ({
  getPipelexClient: () => ({ execute, start, getRunStatus, getRunResult }),
}));

import { runTextStatsBlocking, startTextStatsRun } from "./runTextStatsPipeline";

beforeEach(() => {
  execute.mockReset();
  start.mockReset();
  getRunStatus.mockReset();
  getRunResult.mockReset();
});

// Scaffolded by `make add-method`, and deliberately fixture-free: a test that
// guessed input values from the method's descriptor would be wrong the day the
// method changes. Add your own cases with real inputs once you know what this
// method takes: mock `execute` and `start`, call the action, assert the outcome.
describe("runTextStatsPipeline", () => {
  // The browser's readiness check is the Run button's UX; this is the trust
  // boundary. The gate runs the kernel's rules over the method's own contract.
  it("refuses an empty submission before calling the SDK (blocking)", async () => {
    const result = await runTextStatsBlocking({});
    expect(result).toMatchObject({ ok: false, error: { kind: "bad_request" } });
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses an empty submission before calling the SDK (durable)", async () => {
    const result = await startTextStatsRun({});
    expect(result).toMatchObject({ ok: false, error: { kind: "bad_request" } });
    expect(start).not.toHaveBeenCalled();
  });
});
