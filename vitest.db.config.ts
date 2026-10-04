/// <reference types="vitest" />
import { defineConfig } from "vitest/config";

/**
 * Config for the DB-backed integration suite.
 *
 * WHY A SEPARATE CONFIG. `vitest.config.ts` collects `src` only, and CI
 * (`.github/workflows/ci.yml`) runs no Postgres service. Folding the `db` test
 * directory into the default suite would therefore turn every CI run red on a
 * missing database — and this suite's whole purpose is to prove a REAL round trip
 * against a REAL Postgres, which cannot be skipped or stubbed.
 *
 * These tests run via `bun run test:db`, with `DATABASE_URL` pointed at a local
 * Postgres that already has the migrations applied (`bun run db:migrate`).
 *
 * NOT SKIP-SAFE BY DESIGN. `setupFiles` below throws when `DATABASE_URL` is
 * unset, so running this suite without a database is a hard failure rather than a
 * silently-passing green. A skipped round-trip proves nothing, which is the exact
 * failure mode the card exists to prevent.
 */
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    setupFiles: ["./vitest.db.setup.ts"],
    include: ["db/**/__tests__/**/*.test.ts"],
    // Serial: the suite inserts into one shared local table.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
