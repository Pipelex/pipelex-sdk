import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

interface Manifest {
  imports: Record<string, { node: string }>;
}

/**
 * The package's own subpath imports (`#node-host`), each resolved to the source of its Node
 * target. The `imports` map of `package.json` points into `dist/`, which is what ships, while the
 * suites run the source: without these, a suite would load whatever `dist/` last built, or fail
 * where it was never built. `tests/browser-bundle.test.ts` resolves the map itself, under the
 * browser's conditions and under Node's, against the built package.
 */
export const sourceImports: Record<string, string> = Object.fromEntries(
  Object.entries(
    (JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as Manifest)
      .imports,
  ).map(([name, targets]) => [
    name,
    fileURLToPath(
      new URL(
        targets.node.replace(/^\.\/dist\//, "./src/").replace(/\.js$/, ".ts"),
        import.meta.url,
      ),
    ),
  ]),
);

export default defineConfig({
  resolve: { alias: sourceImports },
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["tests/**", "dist/**", "coverage/**"],
    },
  },
});
