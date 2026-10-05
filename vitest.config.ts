/// <reference types="vitest" />
import path from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    // `e2e/**` is included so the shared harness helpers in `e2e/support/` can
    // carry Vitest negative controls. Playwright's `testMatch` is `*.spec.ts`, so
    // the two runners still never pick up each other's files: a `.test.ts` here
    // is invisible to `playwright test`, and a `.spec.ts` in `e2e/` is
    // invisible to Vitest.
    //
    // `scripts/**` is here for the secret-scan guard
    // (`scripts/__tests__/secret-scan.test.ts`), which is a meta-guard over the
    // committed `.gitignore` and CI workflow rather than over product code. It
    // has to run in the DEFAULT suite — that is the suite `verify` runs, so a
    // guard that only ran in a suite nobody executes is not a guard. It is kept
    // out of `src/core/**` deliberately: that tree is policed by the plugin
    // boundary, and a guard about vendor token prefixes has no business there.
    include: [
      "src/**/*.test.{ts,tsx}",
      "e2e/**/*.test.{ts,tsx}",
      "scripts/**/*.test.{ts,tsx}",
    ],
    css: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
