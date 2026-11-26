/**
 * The format stage's write-back: the formatted file replaces the user's through a temporary file
 * renamed over it, so a failure or a kill at any point leaves the original whole, the original's
 * permission bits, owner and group are kept, nothing is written when the formatter changed
 * nothing, a file a rename would degrade (several hard links, an owner or group the process
 * cannot give) is written in place instead, and a rename Windows refuses while another process
 * holds the file is retried, unless a newer save landed meanwhile, then given up with the file
 * left as it was.
 */

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  replaceFileContent,
  writeBackFormatted,
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
    expect(writeBackFormatted(target, ORIGINAL, { changed: true, formatted: FORMATTED })).toBe(
      "replaced",
    );
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

    expect(
      writeBackFormatted(target, ORIGINAL, { changed: false, formatted: ORIGINAL }, { fs: spy }),
    ).toBe("unchanged");
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
      writeBackFormatted(
        target,
        ORIGINAL,
        { changed: true, formatted: FORMATTED },
        { fs: failing },
      ),
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
      writeBackFormatted(
        target,
        ORIGINAL,
        { changed: true, formatted: FORMATTED },
        { fs: failing },
      ),
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

    writeBackFormatted(target, ORIGINAL, { changed: true, formatted: FORMATTED }, { fs: spy });
    expect(renames).toHaveLength(1);
    const [from, to] = renames[0]!;
    expect(to).toBe(target);
    expect(from.startsWith(join(dir, ".main.mthds."))).toBe(true);
    expect(from.endsWith(".tmp")).toBe(true);
  });

  it("writes a file with several hard links in place, so every name sees the format", () => {
    const other = join(dir, "other.mthds");
    fs.linkSync(target, other);
    const before = fs.statSync(target);

    expect(writeBackFormatted(target, ORIGINAL, { changed: true, formatted: FORMATTED })).toBe(
      "written-in-place",
    );
    expect(fs.statSync(target).ino).toBe(before.ino);
    expect(fs.readFileSync(target, "utf-8")).toBe(FORMATTED);
    expect(fs.readFileSync(other, "utf-8")).toBe(FORMATTED);
    expect(fs.readdirSync(dir).sort()).toEqual(["main.mthds", "other.mthds"]);
  });

  it("keeps the stored name's case when the path names it in another case", (ctx) => {
    const otherCase = join(dir, "MAIN.mthds");
    if (!fs.existsSync(otherCase)) {
      ctx.skip("this filesystem is case-sensitive");
    }
    const renames: string[] = [];
    const spy = fsWith({
      renameSync: (from: fs.PathLike, to: fs.PathLike) => {
        renames.push(String(to));
        fs.renameSync(from, to);
      },
    });

    replaceFileContent(otherCase, ORIGINAL, FORMATTED, { fs: spy });
    expect(renames).toEqual([target]);
    expect(fs.readdirSync(dir)).toEqual(["main.mthds"]);
    expect(fs.readFileSync(target, "utf-8")).toBe(FORMATTED);
  });
});

describe("replaceFileContent and the file's owner and group", () => {
  /** The real `node:fs`, its `fstat` reporting the temporary file as another user's. */
  function createdByAnotherUser(overrides: Partial<FormatWriteFs> = {}): FormatWriteFs {
    return fsWith({
      fstatSync: ((fd: number) => {
        const stats = fs.fstatSync(fd);
        stats.uid += 1;
        return stats;
      }) as FormatWriteFs["fstatSync"],
      ...overrides,
    });
  }

  it("gives the new file the original's owner and group before replacing it", () => {
    const original = fs.statSync(target);
    const chowns: [number, number][] = [];
    const spy = createdByAnotherUser({
      fchownSync: (_fd: number, uid: number, gid: number) => {
        chowns.push([uid, gid]);
      },
    });

    expect(replaceFileContent(target, ORIGINAL, FORMATTED, { fs: spy, platform: "linux" })).toBe(
      "replaced",
    );
    expect(chowns).toEqual([[original.uid, original.gid]]);
    expect(fs.readFileSync(target, "utf-8")).toBe(FORMATTED);
    expect(fs.readdirSync(dir)).toEqual(["main.mthds"]);
  });

  it("writes in place when the original's owner or group cannot be given", () => {
    const before = fs.statSync(target);
    let renamed = false;
    const spy = createdByAnotherUser({
      fchownSync: () => {
        throw errnoError("EPERM");
      },
      renameSync: () => {
        renamed = true;
      },
    });

    expect(replaceFileContent(target, ORIGINAL, FORMATTED, { fs: spy, platform: "linux" })).toBe(
      "written-in-place",
    );
    expect(renamed).toBe(false);
    expect(fs.statSync(target).ino).toBe(before.ino);
    expect(fs.readFileSync(target, "utf-8")).toBe(FORMATTED);
    expect(fs.readdirSync(dir)).toEqual(["main.mthds"]);
  });

  it("changes no owner when the new file already has the original's", () => {
    let chowned = false;
    const spy = fsWith({
      fchownSync: () => {
        chowned = true;
      },
    });

    expect(replaceFileContent(target, ORIGINAL, FORMATTED, { fs: spy, platform: "linux" })).toBe(
      "replaced",
    );
    expect(chowned).toBe(false);
  });

  it("does not look at POSIX ownership on Windows", () => {
    let looked = false;
    const spy = createdByAnotherUser({
      fchownSync: () => {
        looked = true;
        throw errnoError("EPERM");
      },
    });

    expect(replaceFileContent(target, ORIGINAL, FORMATTED, { fs: spy, platform: "win32" })).toBe(
      "replaced",
    );
    expect(looked).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("replaceFileContent on POSIX", () => {
  it("keeps the original file's permission bits, whatever the umask", () => {
    fs.chmodSync(target, 0o640);
    const previousUmask = process.umask(0o077);
    try {
      replaceFileContent(target, ORIGINAL, FORMATTED);
    } finally {
      process.umask(previousUmask);
    }
    expect(fs.statSync(target).mode & 0o7777).toBe(0o640);
    expect(fs.readFileSync(target, "utf-8")).toBe(FORMATTED);
  });

  it("replaces the file a symbolic link points to and keeps the link", () => {
    const link = join(dir, "link.mthds");
    fs.symlinkSync(target, link);

    replaceFileContent(link, ORIGINAL, FORMATTED);
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

    expect(() => replaceFileContent(target, ORIGINAL, FORMATTED, { fs: readOnly })).toThrow(
      /EACCES/,
    );
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
      replaceFileContent(target, ORIGINAL, FORMATTED, { fs: failing, platform: "linux" }),
    ).toThrow(/EPERM/);
    expect(attempts).toBe(1);
  });
});

describe("replaceFileContent on Windows", () => {
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

    replaceFileContent(target, ORIGINAL, FORMATTED, {
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
      replaceFileContent(target, ORIGINAL, FORMATTED, {
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
      replaceFileContent(target, ORIGINAL, FORMATTED, {
        fs: failing,
        platform: "win32",
        sleep: () => undefined,
      }),
    ).toThrow(/ENOENT/);
    expect(attempts).toBe(1);
    expect(fs.readdirSync(dir)).toEqual(["main.mthds"]);
  });

  it("gives up and keeps a newer save made while the file was held", () => {
    let attempts = 0;
    const held = fsWith({
      renameSync: () => {
        attempts += 1;
        throw errnoError("EPERM");
      },
    });

    expect(() =>
      replaceFileContent(target, ORIGINAL, FORMATTED, {
        fs: held,
        platform: "win32",
        renameRetryDelaysMs: [1, 2, 3],
        sleep: () => fs.writeFileSync(target, "newer save\n"),
      }),
    ).toThrow(/changed while its formatted copy waited to replace it; the newer content was kept/);
    expect(attempts).toBe(1);
    expect(fs.readFileSync(target, "utf-8")).toBe("newer save\n");
    expect(fs.readdirSync(dir)).toEqual(["main.mthds"]);
  });

  it("gives up when the held file cannot be read to confirm it is unchanged", () => {
    const held = fsWith({
      renameSync: () => {
        throw errnoError("EBUSY");
      },
      readFileSync: (() => {
        throw errnoError("EBUSY");
      }) as FormatWriteFs["readFileSync"],
    });

    expect(() =>
      replaceFileContent(target, ORIGINAL, FORMATTED, {
        fs: held,
        platform: "win32",
        renameRetryDelaysMs: [1, 2],
        sleep: () => undefined,
      }),
    ).toThrow(/EBUSY.*still held after 1 attempts/);
    expect(fs.readFileSync(target, "utf-8")).toBe(ORIGINAL);
    expect(fs.readdirSync(dir)).toEqual(["main.mthds"]);
  });

  it("says the file was held only when the last refusal was a hold", () => {
    let attempts = 0;
    const heldThenGone = fsWith({
      renameSync: () => {
        attempts += 1;
        throw errnoError(attempts === 1 ? "EPERM" : "ENOENT");
      },
    });

    let message = "";
    try {
      replaceFileContent(target, ORIGINAL, FORMATTED, {
        fs: heldThenGone,
        platform: "win32",
        renameRetryDelaysMs: [1, 2],
        sleep: () => undefined,
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(attempts).toBe(2);
    expect(message).toMatch(/ENOENT/);
    expect(message).not.toMatch(/still held/);
  });
});
