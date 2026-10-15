import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "happy-dom",
    setupFiles: ["./vitest.setup.ts"],
    css: true,
    // Default glob plus the bootstrap skill's anchor-drift test — `**` does
    // not traverse dot-directories, so .claude/ must be listed explicitly.
    include: ["**/*.{test,spec}.?(c|m)[jt]s?(x)", ".claude/skills/bootstrap/scripts/*.test.mjs"],
    exclude: ["e2e/**", "node_modules/**", ".next/**"],
    // The run timeline's entry imports its own stylesheet, which Node cannot
    // load, so Vite transforms the package as it does this app's own files
    // rather than handing it to Node as it does other dependencies.
    server: { deps: { inline: ["@pipelex/mthds-ui"] } },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // A scaffolded action reads its selector from its manifest (tsconfig.json).
      "@methods": path.resolve(__dirname, "./methods"),
      // See the note in vitest.server-only-stub.ts.
      "server-only": path.resolve(__dirname, "./vitest.server-only-stub.ts"),
    },
  },
});
