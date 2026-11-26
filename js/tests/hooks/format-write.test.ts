/**
 * The format stage's write-back: the formatted file replaces the user's through a temporary file
 * renamed over it, so a failure or a kill at any point leaves the original whole, the original's
 * permission bits are kept, nothing is written when the formatter changed nothing, and a rename
 * Windows refuses while another process holds the file is retried, then given up with the file
 * left as it was.
 */

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  writeBackFormatted,
  writeFileAtomically,
  type FormatWriteFs,
} from "../../src/hooks/format-write.js";

const ORIGINAL = 'domain   =  "d"\n';
const FORMATTED = 'domain = "d"\n';

let dir: string;
let target: string;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "hook-format-write-")));
  target = join(dir, "main.mthds");
  fs.writeFileSync(target, ORIGINAL);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The real `node:fs`, with the calls named replaced. */
function fsWith(overrides: Partial<FormatWriteFs>): FormatWriteFs {
  return { ...fs, ...overrides };
}

function errnoError(code: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`${code}: simulated`);
  err.code = code;
  return err;
}

describe("writeBackFormatted", () => {
  it("replaces the file with the formatted text and leaves nothing beside it", () => {
    expect(writeBackFormatted(target, { changed: true, formatted: FORMATTED })).toBe("written");
    expect(fs.readFileSync(target, "utf-8")).toBe(FORMATTED);
    expect(fs.readdirSync(dir)).toEqual(["main.mthds"]);
  });

  it("does not touch a file the formatter left unchanged", () => {
    const before = fs.statSync(target);
    const calls: string[] = [];
    const spy = fsWith({
      openSync: (...args: Parameters<typeof fs.openSync>) => {
        calls.push("open");
        return fs.openSync(...args);
      },
      renameSync: (...args: Parameters<typeof fs.renameSync>) => {
        calls.push("rename");
        fs.renameSync(...args);
      },
    });

    expect(writeBackFormatted(target, { changed: false, formatted: ORIGINAL }, { fs: spy })).toBe(
      "unchanged",
    );
    expect(calls).toEqual([]);
    const after = fs.statSync(target);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(fs.readFileSync(target, "utf-8")).toBe(ORIGINAL);
  });

  it("leaves the original whole and no temporary file when the write fails", () => {
    const failing = fsWith({
      writeFileSync: () => {
        throw errnoError("ENOSPC");
      },
    });

    expect(() =>
      writeBackFormatted(target, { changed: true, formatted: FORMATTED }, { fs: failing }),
    ).toThrow(/ENOSPC/);
    expect(fs.readFileSync(target, "utf-8")).toBe(ORIGINAL);
    expect(fs.readdirSync(dir)).toEqual(["main.mthds"]);
  });

  it("leaves the original whole and no temporary file when the rename fails", () => {
    const failing = fsWith({
      renameSync: () => {
        throw errnoError("EXDEV");
      },
    });

    expect(() =>
      writeBackFormatted(target, { changed: true, formatted: FORMATTED }, { fs: failing }),
    ).toThrow(/EXDEV/);
    expect(fs.readFileSync(target, "utf-8")).toBe(ORIGINAL);
    expect(fs.readdirSync(dir)).toEqual(["main.mthds"]);
  });

  it("writes the temporary file in the target's directory under a hidden name", () => {
    const renames: [string, string][] = [];
    const spy = fsWith({
      renameSync: (from: fs.PathLike, to: fs.PathLike) => {
        renames.push([String(from), String(to)]);
        fs.renameSync(from, to);
      },
    });

    writeBackFormatted(target, { changed: true, formatted: FORMATTED }, { fs: spy });
    expect(renames).toHaveLength(1);
    const [from, to] = renames[0]!;
    expect(to).toBe(target);
    expect(from.startsWith(join(dir, ".main.mthds."))).toBe(true);
    expect(from.endsWith(".tmp")).toBe(true);
  });
});

describe.skipIf(process.platform === "win32")("writeFileAtomically on POSIX", () => {
  it("keeps the original file's permission bits, whatever the umask", () => {
    fs.chmodSync(target, 0o640);
    const previousUmask = process.umask(0o077);
    try {
      writeFileAtomically(target, FORMATTED);
    } finally {
      process.umask(previousUmask);
    }
    expect(fs.statSync(target).mode & 0o7777).toBe(0o640);
    expect(fs.readFileSync(target, "utf-8")).toBe(FORMATTED);
  });

  it("replaces the file a symbolic link points to and keeps the link", () => {
    const link = join(dir, "link.mthds");
    fs.symlinkSync(target, link);

    writeFileAtomically(link, FORMATTED);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, "utf-8")).toBe(FORMATTED);
    expect(fs.readdirSync(dir).sort()).toEqual(["link.mthds", "main.mthds"]);
  });

  it("refuses a file the user cannot write, as the in-place write did", () => {
    const readOnly = fsWith({
      accessSync: () => {
        throw errnoError("EACCES");
      },
    });

    expect(() => writeFileAtomically(target, FORMATTED, { fs: readOnly })).toThrow(/EACCES/);
    expect(fs.readFileSync(target, "utf-8")).toBe(ORIGINAL);
    expect(fs.readdirSync(dir)).toEqual(["main.mthds"]);
  });

  it("does not retry a failed rename off Windows", () => {
    let attempts = 0;
    const failing = fsWith({
      renameSync: () => {
        attempts += 1;
        throw errnoError("EPERM");
      },
    });

    expect(() =>
      writeFileAtomically(target, FORMATTED, { fs: failing, platform: "linux" }),
    ).toThrow(/EPERM/);
    expect(attempts).toBe(1);
  });
});

describe("writeFileAtomically on Windows", () => {
  it("retries a rename refused while another process holds the file, then succeeds", () => {
    let attempts = 0;
    const pauses: number[] = [];
    const heldTwice = fsWith({
      renameSync: (from: fs.PathLike, to: fs.PathLike) => {
        attempts += 1;
        if (attempts <= 2) throw errnoError(attempts === 1 ? "EPERM" : "EBUSY");
        fs.renameSync(from, to);
      },
    });

    writeFileAtomically(target, FORMATTED, {
      fs: heldTwice,
      platform: "win32",
      renameRetryDelaysMs: [5, 7, 9],
      sleep: (ms) => pauses.push(ms),
    });
    expect(attempts).toBe(3);
    expect(pauses).toEqual([5, 7]);
    expect(fs.readFileSync(target, "utf-8")).toBe(FORMATTED);
    expect(fs.readdirSync(dir)).toEqual(["main.mthds"]);
  });

  it("gives up after its retries with the original whole and no temporary file", () => {
    let attempts = 0;
    const pauses: number[] = [];
    const heldForGood = fsWith({
      renameSync: () => {
        attempts += 1;
        throw errnoError("EACCES");
      },
    });

    expect(() =>
      writeFileAtomically(target, FORMATTED, {
        fs: heldForGood,
        platform: "win32",
        renameRetryDelaysMs: [1, 2],
        sleep: (ms) => pauses.push(ms),
      }),
    ).toThrow(/EACCES.*still held after 3 attempts; the file was left as it was/);
    expect(attempts).toBe(3);
    expect(pauses).toEqual([1, 2]);
    expect(fs.readFileSync(target, "utf-8")).toBe(ORIGINAL);
    expect(fs.readdirSync(dir)).toEqual(["main.mthds"]);
  });

  it("does not retry an error no other process causes", () => {
    let attempts = 0;
    const failing = fsWith({
      renameSync: () => {
        attempts += 1;
        throw errnoError("ENOENT");
      },
    });

    expect(() =>
      writeFileAtomically(target, FORMATTED, {
        fs: failing,
        platform: "win32",
        sleep: () => undefined,
      }),
    ).toThrow(/ENOENT/);
    expect(attempts).toBe(1);
    expect(fs.readdirSync(dir)).toEqual(["main.mthds"]);
  });
});
