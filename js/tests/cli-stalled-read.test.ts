/**
 * Ctrl-C while a local read never completes, as a bundle on a stalled network mount would: the
 * command must stop waiting for the read, say that no run was started, and send nothing. A named
 * pipe cannot stand in for the stalled file, since the bundle reader reads regular files only, so
 * `readFile` is replaced here by one that never settles for a `.mthds` file. It lives in its own
 * file so that the replacement touches no other suite.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    readFile: (...args: Parameters<typeof original.readFile>) =>
      String(args[0]).endsWith(".mthds")
        ? new Promise<never>(() => undefined)
        : original.readFile(...args),
  };
});

const { runCommand } = await import("../src/cli/main.js");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("an interrupt during a local read that never completes", () => {
  it("ends the command while the bundle is read, and sends nothing", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pipelex-sdk-cli-")));
    fs.writeFileSync(path.join(root, "receipt-review.mthds"), 'domain = "receipts"\n');
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const interrupt = new AbortController();
    let stderr = "";
    const previous = process.cwd();
    process.chdir(root);
    try {
      const code = runCommand(["run", "--method", "receipt-review.mthds"], {
        env: { PIPELEX_API_KEY: "pk_case_key", PIPELEX_BASE_URL: "http://api.test" },
        readStdin: () => Promise.resolve(new Uint8Array()),
        writeStdout: () => undefined,
        writeStderr: (text) => {
          stderr += text;
        },
        interrupt: interrupt.signal,
      });
      setTimeout(() => interrupt.abort(), 20);

      expect(await code).toBe(130);
      expect(stderr).toBe("Interrupted. No run was started.\n");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      process.chdir(previous);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 2_000);
});
