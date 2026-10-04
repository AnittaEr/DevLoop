import { defineConfig, devices } from "@playwright/test";

const PORT = 3000;
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  // Specs live outside src/, so Vitest's `src/**/*.test.*` include can never
  // pick them up. This glob keeps `playwright test` away from src/ unit tests.
  testMatch: /.*\.spec\.ts/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL,
    // Headless-by-default behaviour is identical locally and in CI (the
    // chromium project uses the bundled Chrome channel-less build, headless
    // unless `--headed` is passed). CI/telemetry flags are pinned in
    // webServer.env below; Playwright's typed `use` block rejects a `CI` key.
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "bun run start",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      // Playwright does not forward the whole shell env to the server unless
      // asked; set these explicitly so the build never reaches out.
      NEXT_TELEMETRY_DISABLED: "1",
      CI: process.env.CI ?? "",
    },
  },
});
