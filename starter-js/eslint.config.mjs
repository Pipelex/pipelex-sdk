import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

const eslintConfig = defineConfig([
  ...nextVitals,
  // `src/generated/**` is written verbatim from the codegen API and hashed
  // against per-file stamps — any autofixing rule is a byte rewrite that would
  // break the trust chain. `tsc` still covers the trees (they sit inside the
  // base tsconfig), which is the check that matters for generated code.
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "src/generated/**"]),
  {
    // Route diagnostics through structured errors (classifyPipelineError),
    // not stray console writes. Mirrors mthds-js / mthds-ui.
    rules: {
      "no-console": "error",
    },
  },
  {
    // e2e specs may log for debugging — same carve-out the siblings give tests.
    files: ["e2e/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },
  {
    // Build/tooling files (root configs, skill CLI scripts) write to the
    // terminal by design — there is no classifyPipelineError there, console
    // IS the output channel. Mirrors mthds-js's CLI-entrypoint carve-out.
    files: ["*.config.{ts,mts,cts,js,mjs,cjs}", ".claude/skills/**/*.mjs", "scripts/**/*.mts"],
    rules: {
      "no-console": "off",
    },
  },
]);

export default eslintConfig;
