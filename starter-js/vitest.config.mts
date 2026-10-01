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
