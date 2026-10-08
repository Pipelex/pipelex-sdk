/**
 * Ctrl-C during `script`'s local steps, which no request races: its last check that the target is
 * free, the one made once the catalog entry has named the script, after which the command must
 * write nothing, say so, and exit 130; and the write itself, after which the file is whole and the
 * command must say it was written, and exit 130. `lstat` and `writeFile` are replaced here by ones
 * that let the interrupt land while they run. It lives in its own file so that the replacement
 * touches no other suite.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Called by the replaced `lstat` with each path it is asked about. */
let onLstat: (target: string) => void = () => undefined;
/** Called by the replaced `writeFile` with each path it writes, once the write has started. */
let onWriteFile: (target: string) => void = () => undefined;

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    lstat: (...args: Parameters<typeof original.lstat>) => {
      onLstat(String(args[0]));
      return original.lstat(...args);
    },
    writeFile: (...args: Parameters<typeof original.writeFile>) => {
      const written = original.writeFile(...args);
      onWriteFile(String(args[0]));
      return written;
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
  onWriteFile = () => undefined;
  vi.restoreAllMocks();
});

interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
  /** The files the command left in its working directory, each with its text. */
  files: Record<string, string>;
}

/** Run `script --method mt_receipts01` in a fresh directory, the API answering as it should. */
async function runScript(interrupt: AbortController): Promise<Outcome> {
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
    const files = Object.fromEntries(
      fs.readdirSync(root).map((name) => [name, fs.readFileSync(path.join(root, name), "utf8")]),
    );
    return { code, stdout, stderr, files };
  } finally {
    process.chdir(previous);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("an interrupt during script's last check before it writes", () => {
  it("writes nothing, says so, and exits 130", async () => {
    const interrupt = new AbortController();
    onLstat = (target) => {
      if (target.endsWith(`${path.sep}receipt-review`)) interrupt.abort();
    };

    const outcome = await runScript(interrupt);

    expect(interrupt.signal.aborted).toBe(true);
    expect(outcome).toEqual({
      code: 130,
      stdout: "",
      stderr: "Interrupted. Nothing was written.\n",
      files: {},
    });
  }, 2_000);
});

describe("an interrupt while script writes its file", () => {
  it("leaves the file whole, says it was written, and exits 130", async () => {
    const interrupt = new AbortController();
    onWriteFile = () => interrupt.abort();

    const outcome = await runScript(interrupt);

    expect(interrupt.signal.aborted).toBe(true);
    expect(outcome.code).toBe(130);
    expect(outcome.stdout).toBe("");
    expect(outcome.stderr).toBe("Interrupted. ./receipt-review was written.\n");
    expect(Object.keys(outcome.files)).toEqual(["receipt-review"]);
    expect(outcome.files["receipt-review"]).toMatch(
      /^#!\/bin\/sh\n[\s\S]*\nexec npx --yes @pipelex\/sdk@/,
    );
  }, 2_000);
});
