/**
 * Ctrl-C during `script`'s last check that the target is free, the one made once the catalog entry
 * has named the script: the command must write nothing, say so, and exit 130. That check is a
 * local `lstat` no request races, so `lstat` is replaced here by one that lets the interrupt land
 * while it runs. It lives in its own file so that the replacement touches no other suite.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Called by the replaced `lstat` with each path it is asked about. */
let onLstat: (target: string) => void = () => undefined;

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    lstat: (...args: Parameters<typeof original.lstat>) => {
      onLstat(String(args[0]));
      return original.lstat(...args);
    },
  };
});

const { runCommand } = await import("../src/cli/main.js");

interface NamedAnswer {
  status: number;
  body: unknown;
}

const TABLE = JSON.parse(
  fs.readFileSync(new URL("./fixtures/cli-cases.json", import.meta.url), "utf8"),
) as { answers: Record<string, NamedAnswer> };

const CATALOG_ENTRY = {
  method_id: "mt_receipts01",
  org_id: "org_1",
  created_by_user_id: "user_1",
  name: "Receipt Review",
  mthds: 'domain = "receipts"\nmain_pipe = "review_receipt"\n',
  python: "",
  created_at: "2026-10-01T09:00:00Z",
  updated_at: "2026-10-01T09:00:00Z",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  onLstat = () => undefined;
  vi.restoreAllMocks();
});

describe("an interrupt during script's last check before it writes", () => {
  it("writes nothing, says so, and exits 130", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pipelex-sdk-cli-")));
    const pipeIo = TABLE.answers["pipe-io/receipt-review"];
    if (pipeIo === undefined) throw new Error("the table has no pipe-io/receipt-review answer");
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/v1/pipe-io") return Promise.resolve(jsonResponse(200, pipeIo.body));
      if (pathname === "/v1/methods/mt_receipts01") {
        return Promise.resolve(jsonResponse(200, CATALOG_ENTRY));
      }
      throw new Error(`unexpected request to ${pathname}`);
    });
    const interrupt = new AbortController();
    onLstat = (target) => {
      if (target.endsWith(`${path.sep}receipt-review`)) interrupt.abort();
    };
    let stdout = "";
    let stderr = "";
    const previous = process.cwd();
    process.chdir(root);
    try {
      const code = await runCommand(["script", "--method", "mt_receipts01"], {
        env: { PIPELEX_API_KEY: "pk_case_key", PIPELEX_BASE_URL: "http://api.test" },
        readStdin: () => Promise.resolve(new Uint8Array()),
        writeStdout: (text) => {
          stdout += text;
        },
        writeStderr: (text) => {
          stderr += text;
        },
        interrupt: interrupt.signal,
      });

      expect(interrupt.signal.aborted).toBe(true);
      expect(code).toBe(130);
      expect(stdout).toBe("");
      expect(stderr).toBe("Interrupted. Nothing was written.\n");
      expect(fs.readdirSync(root)).toEqual([]);
    } finally {
      process.chdir(previous);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 2_000);
});
