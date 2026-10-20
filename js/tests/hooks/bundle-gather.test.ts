/**
 * The method tree the hook's validate stage sends around an edited `.mthds` file: the edited
 * file's directory listed by the `mthds` package's lister, under the MTHDS standard's membership
 * rule and Manifest Discovery, held to the hook's caps, whose breach must read as `unavailable`
 * upstream, as must a tree the lister refuses and an edited file the tree does not hold.
 */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_GATHER_CAPS, gatherMethodTree } from "../../src/hooks/bundle-gather.js";

let root: string;

beforeEach(() => {
  // The lister roots a tree at its physical path, so the scratch directory is named by its own.
  root = realpathSync(mkdtempSync(join(tmpdir(), "hook-gather-")));
  // An entry named `.git` stops Manifest Discovery here, whatever lies above the scratch directory.
  writeFileSync(join(root, ".git"), "");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const put = (relPath: string, content: string | Uint8Array = `domain = "d"\n`): string => {
  const full = join(root, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
  return full;
};

const TEMPLATE = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00]);

describe("gatherMethodTree", () => {
  it("lists the edited file's directory as the method's tree, every file the rule keeps", async () => {
    const edited = put("main.mthds", `domain = "edited"\n`);
    put("nested/deep.mthds");
    put("templates/invoice.docx", TEMPLATE);
    put("README.md", "# notes");

    const result = await gatherMethodTree(edited);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tree.files.map((file) => file.path)).toEqual([
      "README.md",
      "main.mthds",
      "nested/deep.mthds",
      "templates/invoice.docx",
    ]);
    expect(new TextDecoder().decode(await result.tree.readFile("main.mthds"))).toBe(
      `domain = "edited"\n`,
    );
    expect(await result.tree.readFile("templates/invoice.docx")).toEqual(Buffer.from(TEMPLATE));
  });

  it("leaves out what the membership rule excludes, a run's inputs file among them", async () => {
    const edited = put("main.mthds");
    put("inputs.json", `{"text": "hello"}`);
    put("nested/inputs.toml", `text = "hello"\n`);
    put(".cache/hidden.mthds");
    put("node_modules/pkg/dep.mthds");
    put("__pycache__/cache.mthds");

    const result = await gatherMethodTree(edited);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tree.files.map((file) => file.path)).toEqual(["main.mthds"]);
  });

  it("roots the tree at the nearest METHODS.toml above the edited file", async () => {
    put("METHODS.toml", "");
    put("shared.mthds");
    const edited = put("methods/receipts/main.mthds");

    const result = await gatherMethodTree(edited);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tree.files.map((file) => file.path)).toEqual([
      "METHODS.toml",
      "methods/receipts/main.mthds",
      "shared.mthds",
    ]);
  });

  it("overflows past the file count cap", async () => {
    const edited = put("main.mthds");
    put("a.mthds");
    put("b.mthds");

    const result = await gatherMethodTree(edited, { ...DEFAULT_GATHER_CAPS, maxFiles: 2 });

    expect(result).toEqual({ ok: false, reason: "overflow" });
  });

  it("overflows past the total size cap", async () => {
    const edited = put("main.mthds", "x".repeat(60));
    put("other.mthds", "y".repeat(60));

    const result = await gatherMethodTree(edited, { ...DEFAULT_GATHER_CAPS, maxTotalBytes: 100 });

    expect(result).toEqual({ ok: false, reason: "overflow" });
  });

  it("overflows on one file over the per-file cap", async () => {
    const edited = put("main.mthds");
    put("templates/invoice.docx", new Uint8Array(200));

    const result = await gatherMethodTree(edited, { ...DEFAULT_GATHER_CAPS, maxFileBytes: 100 });

    expect(result).toEqual({ ok: false, reason: "overflow" });
  });

  it("reports outside when the edited file is not in its tree", async () => {
    // A file of a `.git`-free directory under an excluded one is kept out of the tree its
    // manifest roots, so validating that tree would judge the method without the file edited.
    put("METHODS.toml", "");
    const edited = put("node_modules/pkg/main.mthds");

    const result = await gatherMethodTree(edited);

    expect(result).toEqual({ ok: false, reason: "outside" });
  });

  it("reports unreadable when the edited file's directory vanished", async () => {
    const edited = put("gone/main.mthds");
    rmSync(join(root, "gone"), { recursive: true });

    const result = await gatherMethodTree(edited);

    expect(result).toEqual({ ok: false, reason: "unreadable" });
  });

  it("reports unreadable for a tree holding a symbolic link, which the standard refuses", async ({
    skip,
  }) => {
    skip(process.platform === "win32");
    const edited = put("main.mthds");
    const outside = mkdtempSync(join(tmpdir(), "hook-gather-outside-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "not part of the method");
      symlinkSync(join(outside, "secret.txt"), join(root, "linked.txt"));

      const result = await gatherMethodTree(edited);

      expect(result).toEqual({ ok: false, reason: "unreadable" });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("reports unreadable when a subdirectory cannot be listed", async ({ skip }) => {
    // Root can traverse a 0-perm directory, so this scenario is unobservable
    // when the suite runs as root (common in CI containers). Windows ACLs ignore
    // chmod 0o000 entirely, so the directory stays readable there too.
    skip(
      process.platform === "win32" ||
        (typeof process.getuid === "function" && process.getuid() === 0),
    );
    const edited = put("main.mthds");
    const locked = join(root, "locked");
    mkdirSync(locked);
    writeFileSync(join(locked, "hidden.mthds"), `domain = "d"\n`);
    chmodSync(locked, 0o000);
    try {
      const result = await gatherMethodTree(edited);
      expect(result).toEqual({ ok: false, reason: "unreadable" });
    } finally {
      // Restore perms so afterEach can remove the tree.
      chmodSync(locked, 0o700);
    }
  });
});
