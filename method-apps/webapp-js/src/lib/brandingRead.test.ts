// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiResponseError } from "@pipelex/sdk";
import { BRANDED, UNBRANDED } from "@/test/fixtures/branding";

const getBranding = vi.fn();
const getPipelexClient = vi.fn(() => ({ getBranding }));

vi.mock("@/lib/pipelexClient", () => ({
  getPipelexClient: () => getPipelexClient(),
}));

type ReadModule = typeof import("@/lib/brandingRead");

/** A fresh module, so what one test remembered never reaches the next. */
async function load(): Promise<ReadModule> {
  vi.resetModules();
  return import("@/lib/brandingRead");
}

function refused(status: number): ApiResponseError {
  return new ApiResponseError(
    `HTTP ${status}`,
    "https://api.test",
    status,
    "",
    "",
    undefined,
    undefined,
    undefined,
    undefined,
  );
}

beforeEach(() => {
  getBranding.mockReset();
  getPipelexClient.mockClear();
  vi.stubEnv("PIPELEX_API_KEY", "test-key");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("readOrganizationBranding", () => {
  it("answers the branding the deployment's key reads", async () => {
    const { readOrganizationBranding } = await load();
    getBranding.mockResolvedValueOnce(BRANDED);
    await expect(readOrganizationBranding()).resolves.toBe(BRANDED);
    expect(getBranding).toHaveBeenCalledTimes(1);
  });

  it("reads nothing without an API key", async () => {
    vi.stubEnv("PIPELEX_API_KEY", "");
    const { readOrganizationBranding } = await load();
    await expect(readOrganizationBranding()).resolves.toBeNull();
    expect(getBranding).not.toHaveBeenCalled();
  });

  it("keeps an answer for a minute, then reads again", async () => {
    vi.useFakeTimers();
    const { readOrganizationBranding, BRANDING_FRESH_MS } = await load();
    getBranding.mockResolvedValueOnce(UNBRANDED).mockResolvedValueOnce(BRANDED);

    await expect(readOrganizationBranding()).resolves.toBe(UNBRANDED);
    await expect(readOrganizationBranding()).resolves.toBe(UNBRANDED);
    expect(getBranding).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(BRANDING_FRESH_MS + 1);
    await expect(readOrganizationBranding()).resolves.toBe(BRANDED);
    expect(getBranding).toHaveBeenCalledTimes(2);
  });

  it("shares one read between page views that arrive while it is in flight", async () => {
    const { readOrganizationBranding } = await load();
    let answer!: (value: unknown) => void;
    getBranding.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const first = readOrganizationBranding();
    const second = readOrganizationBranding();
    answer(BRANDED);
    await expect(Promise.all([first, second])).resolves.toEqual([BRANDED, BRANDED]);
    expect(getBranding).toHaveBeenCalledTimes(1);
  });

  it("answers null on a failure, logs it once, and tries again after the retry delay", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { readOrganizationBranding, BRANDING_RETRY_MS } = await load();
    getBranding
      .mockRejectedValueOnce(refused(404))
      .mockRejectedValueOnce(refused(404))
      .mockResolvedValueOnce(BRANDED);

    await expect(readOrganizationBranding()).resolves.toBeNull();
    // Kept: the next page view does not ask again at once.
    await expect(readOrganizationBranding()).resolves.toBeNull();
    expect(getBranding).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(BRANDING_RETRY_MS + 1);
    await expect(readOrganizationBranding()).resolves.toBeNull();
    // The same failure twice is logged once.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/branding not read, rendering unbranded: .*404/);

    vi.advanceTimersByTime(BRANDING_RETRY_MS + 1);
    await expect(readOrganizationBranding()).resolves.toBe(BRANDED);
  });

  it("never logs the API key", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { readOrganizationBranding } = await load();
    getBranding.mockRejectedValueOnce(new Error("socket hang up"));
    await readOrganizationBranding();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).not.toContain("test-key");
  });

  it("renders unbranded when the read outlasts its timeout, and wears the late answer next", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { readOrganizationBranding, BRANDING_TIMEOUT_MS } = await load();
    let answer!: (value: unknown) => void;
    getBranding.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));

    const page = readOrganizationBranding();
    await vi.advanceTimersByTimeAsync(BRANDING_TIMEOUT_MS + 1);
    await expect(page).resolves.toBeNull();
    expect(warn.mock.calls[0]![0]).toMatch(/no answer within 3 s/);

    answer(BRANDED);
    await vi.advanceTimersByTimeAsync(0);
    await expect(readOrganizationBranding()).resolves.toBe(BRANDED);
    expect(getBranding).toHaveBeenCalledTimes(1);
  });

  it("answers no branding, and never rejects, when the client cannot even be built", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { readOrganizationBranding } = await load();
    // The SDK's constructor throws on a base URL with a path, before any read.
    getPipelexClient.mockImplementationOnce(() => {
      throw new Error("the base URL must be an origin, without a path");
    });
    await expect(readOrganizationBranding()).resolves.toBeNull();
    expect(getBranding).not.toHaveBeenCalled();
    expect(warn.mock.calls[0]![0]).toMatch(/rendering unbranded: the base URL must be an origin/);
  });

  it("keeps serving the last branding read through a failed refresh, and reads again after it", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { readOrganizationBranding, BRANDING_FRESH_MS, BRANDING_RETRY_MS } = await load();
    getBranding
      .mockResolvedValueOnce(BRANDED)
      .mockRejectedValueOnce(refused(503))
      .mockResolvedValueOnce(UNBRANDED);

    await expect(readOrganizationBranding()).resolves.toBe(BRANDED);
    vi.advanceTimersByTime(BRANDING_FRESH_MS + 1);

    // The refresh fails: the logo route and the page keep the branding they had.
    await expect(readOrganizationBranding()).resolves.toBe(BRANDED);
    expect(warn.mock.calls[0]![0]).toMatch(/keeping the last branding read: .*503/);
    await expect(readOrganizationBranding()).resolves.toBe(BRANDED);
    expect(getBranding).toHaveBeenCalledTimes(2);

    // After the failure window, it reads again and wears what it gets.
    vi.advanceTimersByTime(BRANDING_RETRY_MS + 1);
    await expect(readOrganizationBranding()).resolves.toBe(UNBRANDED);
    expect(getBranding).toHaveBeenCalledTimes(3);
  });

  it("keeps the last branding read when a refresh times out", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { readOrganizationBranding, BRANDING_FRESH_MS, BRANDING_TIMEOUT_MS } = await load();
    getBranding.mockResolvedValueOnce(BRANDED).mockReturnValueOnce(new Promise(() => {}));

    await expect(readOrganizationBranding()).resolves.toBe(BRANDED);
    vi.advanceTimersByTime(BRANDING_FRESH_MS + 1);
    const page = readOrganizationBranding();
    await vi.advanceTimersByTimeAsync(BRANDING_TIMEOUT_MS + 1);
    await expect(page).resolves.toBe(BRANDED);
  });

  it("never lets a read given up on overwrite the answer of a newer one", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { readOrganizationBranding, BRANDING_RETRY_MS, BRANDING_TIMEOUT_MS } = await load();
    let settleStranded!: (value: unknown) => void;
    getBranding
      .mockReturnValueOnce(new Promise((resolve) => (settleStranded = resolve)))
      .mockResolvedValueOnce(BRANDED);

    // The first read is given up on, and the failure window passes with it still out.
    const first = readOrganizationBranding();
    await vi.advanceTimersByTimeAsync(BRANDING_TIMEOUT_MS + 1);
    await expect(first).resolves.toBeNull();
    vi.advanceTimersByTime(BRANDING_RETRY_MS + 1);

    // A newer read answers, then the stranded one settles with an older answer.
    await expect(readOrganizationBranding()).resolves.toBe(BRANDED);
    settleStranded(UNBRANDED);
    await vi.advanceTimersByTimeAsync(0);

    await expect(readOrganizationBranding()).resolves.toBe(BRANDED);
    expect(getBranding).toHaveBeenCalledTimes(2);
  });
});
