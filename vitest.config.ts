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
    include: ["src/**/*.test.{ts,tsx}", "e2e/**/*.test.{ts,tsx}"],
    css: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
