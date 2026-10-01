import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bundleOrder, loadMethodBundles } from "./loadBundle";

let methodsDir: string;

beforeEach(async () => {
  methodsDir = await mkdtemp(path.join(os.tmpdir(), "method-app-bundles-"));
});

afterEach(async () => {
  await rm(methodsDir, { recursive: true, force: true });
});

async function put(relative: string, content: string): Promise<void> {
  const target = path.join(methodsDir, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf-8");
}

describe("loadMethodBundles", () => {
  it("reads every .mthds file of the method, at any depth, in sorted path order", async () => {
    await put("cv-screening/main.mthds", "MAIN");
    await put("cv-screening/concepts.mthds", "CONCEPTS");
    await put("cv-screening/steps/score.mthds", "SCORE");
    await put("cv-screening/README.md", "not a bundle");

    await expect(loadMethodBundles("cv-screening", methodsDir)).resolves.toEqual([
      "CONCEPTS",
      "MAIN",
      "SCORE",
    ]);
  });

  // Codegen's walk compares `/`-joined relative paths, where `/` sorts before
  // `2`: a directory's files come before a sibling file extending its name.
  it("orders a directory's files before a sibling that extends its name, as codegen does", async () => {
    await put("cv-screening/steps2.mthds", "STEPS2");
    await put("cv-screening/steps/score.mthds", "SCORE");

    await expect(loadMethodBundles("cv-screening", methodsDir)).resolves.toEqual([
      "SCORE",
      "STEPS2",
    ]);
  });

  it("reads only the named method's directory", async () => {
    await put("first/main.mthds", "FIRST");
    await put("second/main.mthds", "SECOND");

    await expect(loadMethodBundles("first", methodsDir)).resolves.toEqual(["FIRST"]);
  });

  it("rejects with ENOENT when the directory is missing", async () => {
    await expect(loadMethodBundles("absent", methodsDir)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects with ENOENT when the directory holds no bundle", async () => {
    // A selector-sourced method's directory holds a method.json and no bundle.
    await put("published/method.json", "{}");
    await expect(loadMethodBundles("published", methodsDir)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each(["../escape", "Upper", "a/b", "", "3d-model"])(
    "refuses a name that is not kebab-case: %j",
    async (name) => {
      await expect(loadMethodBundles(name, methodsDir)).rejects.toThrow(/not a method directory/);
    },
  );
});

describe("bundleOrder", () => {
  it("sorts on the /-joined path under the method directory on Windows too", () => {
    const dir = "C:\\app\\methods\\cv-screening";
    const files = ["steps2.mthds", "steps\\score.mthds", "main.mthds"].map(
      (relative) => `${dir}\\${relative}`,
    );

    // Sorting the absolute paths would put steps2.mthds first: `\` sorts after `2`.
    expect(bundleOrder(dir, files, path.win32)).toEqual([
      "main.mthds",
      "steps/score.mthds",
      "steps2.mthds",
    ]);
  });
});
