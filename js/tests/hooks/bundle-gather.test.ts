/**
 * Bundle-gathering tests: the multi-file set sent to `/v1/validate` around an
 * edited `.mthds` file — recursive parent-dir scan, exclusions, deterministic
 * order (edited file first), and the caps whose overflow must read as
 * `unavailable` upstream (an under-supplied bundle risks a false block).
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gatherBundle, templateFilesNamedBy } from "../../src/hooks/bundle-gather.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hook-gather-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const put = (relPath: string, content = `domain = "d"\n`): string => {
  const full = join(root, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
  return full;
};

describe("gatherBundle", () => {
  it("returns the edited file first, then siblings and nested files sorted", () => {
    const edited = put("b_edited.mthds", `domain = "edited"\n`);
    put("a_sibling.mthds");
    put("nested/deep.mthds");

    const result = gatherBundle(edited);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files.map((file) => file.uri)).toEqual([
      "b_edited.mthds",
      "a_sibling.mthds",
      join("nested", "deep.mthds"),
    ]);
    expect(result.files[0]?.content).toBe(`domain = "edited"\n`);
  });

  it("skips dot-directories and excluded dirs", () => {
    const edited = put("main.mthds");
    put(".git/hidden.mthds");
    put("node_modules/pkg/dep.mthds");
    put("__pycache__/cache.mthds");
    put("results/out.mthds");

    const result = gatherBundle(edited);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files.map((file) => file.uri)).toEqual(["main.mthds"]);
  });

  it("ignores non-mthds files", () => {
    const edited = put("main.mthds");
    writeFileSync(join(root, "README.md"), "# nope");

    const result = gatherBundle(edited);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files).toHaveLength(1);
  });

  it("overflows on too many files", () => {
    const edited = put("main.mthds");
    for (let i = 0; i < 3; i++) {
      put(`extra_${i}.mthds`);
    }
    const result = gatherBundle(edited, { maxFiles: 3, maxTotalBytes: 1024 * 1024 });
    expect(result).toEqual({ ok: false, reason: "overflow" });
  });

  it("overflows on too many bytes", () => {
    const edited = put("main.mthds", "x".repeat(2048));
    const result = gatherBundle(edited, { maxFiles: 50, maxTotalBytes: 1024 });
    expect(result).toEqual({ ok: false, reason: "overflow" });
  });

  it("reports unreadable when the edited file vanished", () => {
    const edited = put("main.mthds");
    rmSync(edited);
    const result = gatherBundle(edited);
    expect(result).toEqual({ ok: false, reason: "unreadable" });
  });

  it("reports unreadable when a subdirectory cannot be scanned", ({ skip }) => {
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
      const result = gatherBundle(edited);
      expect(result).toEqual({ ok: false, reason: "unreadable" });
    } finally {
      // Restore perms so afterEach can remove the tree.
      chmodSync(locked, 0o700);
    }
  });
});

/** A `.mthds` file whose one step fills the office template `templateFile` names. */
const docGenBundle = (templateFile: string, domain = "invoicing"): string => `domain = "${domain}"

[pipe.print_invoice]
type          = "PipeDocGen"
description   = "Print the invoice"
inputs        = { invoice = "Text" }
output        = "Document"
format        = "docx"
template_file = "${templateFile}"
`;

const putBytes = (relPath: string, bytes: Uint8Array): string => {
  const full = join(root, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, bytes);
  return full;
};

const TEMPLATE = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00]);

describe("templateFilesNamedBy", () => {
  it("names each PipeDocGen step's template_file, and nothing else", () => {
    const content = `${docGenBundle("templates/invoice.docx")}
[pipe.summarize]
type = "PipeLLM"
description = "Summarize"
template_file = "not/a/docgen.docx"

[pipe.print_receipt]
type = "PipeDocGen"
description = "Print the receipt as a PDF"
format = "pdf"
`;
    expect(templateFilesNamedBy(content)).toEqual(["templates/invoice.docx"]);
  });

  it("names none in a file that does not parse, or has no pipe table", () => {
    expect(templateFilesNamedBy("domain = [unclosed")).toEqual([]);
    expect(templateFilesNamedBy(`domain = "d"\npipe = 3\n`)).toEqual([]);
  });
});

describe("gatherBundle — the template files the steps read", () => {
  it("reads each beside the .mthds file whose step names it, keyed by the path the step names", () => {
    const edited = put("main.mthds", docGenBundle("./templates/invoice.docx"));
    put("sub/receipt.mthds", docGenBundle("receipt.docx", "receipts"));
    putBytes("templates/invoice.docx", TEMPLATE);
    putBytes("sub/receipt.docx", TEMPLATE);
    // The runtime reads every file of the request as sitting in one directory, so the
    // nested file's template is sent under the path its step names.
    const result = gatherBundle(edited);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.resources).sort()).toEqual([
      "receipt.docx",
      "templates/invoice.docx",
    ]);
    expect(Buffer.from(result.resources["templates/invoice.docx"]!)).toEqual(Buffer.from(TEMPLATE));
  });

  it("sends none for a bundle whose steps read no file", () => {
    const edited = put("main.mthds");
    const result = gatherBundle(edited);
    expect(result).toEqual({ ok: true, files: expect.any(Array), resources: {} });
  });

  it("leaves out a file that is not there and a path the server would refuse", () => {
    const edited = put("bundle/main.mthds", docGenBundle("templates/missing.docx"));
    put("bundle/other.mthds", docGenBundle("../outside.docx", "other"));
    putBytes("outside.docx", TEMPLATE);
    const result = gatherBundle(edited);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resources).toEqual({});
  });

  it("reads one file once when two steps name it", () => {
    const edited = put("main.mthds", docGenBundle("t.docx"));
    put("again.mthds", docGenBundle("./t.docx", "again"));
    putBytes("t.docx", TEMPLATE);
    const result = gatherBundle(edited);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.resources)).toEqual(["t.docx"]);
  });

  it("accepts one path naming the same bytes beside two .mthds files", () => {
    const edited = put("main.mthds", docGenBundle("t.docx"));
    put("sub/other.mthds", docGenBundle("t.docx", "other"));
    putBytes("t.docx", TEMPLATE);
    putBytes("sub/t.docx", TEMPLATE);
    const result = gatherBundle(edited);
    expect(result.ok).toBe(true);
  });

  it("reports a conflict when one path names two different files", () => {
    const edited = put("main.mthds", docGenBundle("t.docx"));
    put("sub/other.mthds", docGenBundle("t.docx", "other"));
    putBytes("t.docx", TEMPLATE);
    putBytes("sub/t.docx", new Uint8Array([1, 2, 3]));
    expect(gatherBundle(edited)).toEqual({ ok: false, reason: "conflict" });
  });

  it("never reads a template that leads out of the bundle's directory", ({ skip }) => {
    skip(process.platform === "win32");
    const outside = mkdtempSync(join(tmpdir(), "hook-outside-"));
    try {
      writeFileSync(join(outside, "secret.docx"), TEMPLATE);
      const bundle = join(root, "bundle");
      mkdirSync(bundle);
      const edited = join(bundle, "main.mthds");
      writeFileSync(edited, docGenBundle("t.docx"));
      symlinkSync(join(outside, "secret.docx"), join(bundle, "t.docx"));
      expect(gatherBundle(edited)).toEqual({ ok: false, reason: "unreadable" });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("overflows past the template caps", () => {
    const edited = put("main.mthds", docGenBundle("a.docx"));
    put("b.mthds", docGenBundle("b.docx", "b"));
    putBytes("a.docx", TEMPLATE);
    putBytes("b.docx", TEMPLATE);
    const caps = { maxFiles: 50, maxTotalBytes: 1024 * 1024 };
    expect(gatherBundle(edited, { ...caps, maxResourceFiles: 1 })).toEqual({
      ok: false,
      reason: "overflow",
    });
    expect(gatherBundle(edited, { ...caps, maxResourceBytes: TEMPLATE.length })).toEqual({
      ok: false,
      reason: "overflow",
    });
    expect(gatherBundle(edited, caps).ok).toBe(true);
  });
});
