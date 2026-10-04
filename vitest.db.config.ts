/// <reference types="vitest" />
import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * WHY `@` IS RESOLVED HERE. This config previously collected only `db/**`,
 * whose modules reach everything else by relative path, so it needed no alias.
 * `src/app/sources/__tests__/persist-canonical-events-upsert.test.ts` reaches
 * its own subject through `@/core/...` and `@/lib/db/client`, so without the
 * alias below the file fails to resolve at import time — i.e. it would be
 * collected and then ERROR, which is not better than not collecting it. The
 * alias is declared identically to `vitest.config.ts` (`@` -> `./src`), so the
 * same specifier resolves to the same module in both suites.
 *
 * WHY THE SUITE STILL GATES ON `DATABASE_URL` INTERNALLY. The include below is
 * what makes this file RUN in the `db round trip` job; the `describeWithDb` in
 * the file is a second, independent guard for developers who run the DEFAULT
 * `bun run test` with no database. Both are needed and neither subsumes the
 * other: this include decides whether the file is collected at all, the
 * internal gate decides whether it asserts or skips once collected.
 */

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
    // The upsert proof is collected HERE, not only by the default suite,
    // because the default suite runs in the `verify` job which has NO database —
    // so the file's `describeWithDb` collapsed to `describe.skip` there and all
    // 7 assertions were reported as skipped. A skipped suite is indistinguishable
    // from a passing one in a green CI run, which is the self-certifying-green
    // defect this entry exists to close.
    //
    // NAMED FILE, NOT A `src/**` GLOB — deliberately. Measured on this branch: a
    // `src/app/sources/__tests__/**` glob also collects
    // `composition-root.test.ts`, which needs NO database and DELETES
    // `process.env.DATABASE_URL` inside one of its tests to prove the lazy client
    // is not constructed eagerly. Running that file inside a suite whose every
    // other file depends on that variable is a hazard in exchange for no added
    // coverage, so the db job keeps exactly the files that need a real database.
    //
    // THE COST, STATED PLAINLY: this list is now the single registry of db-backed
    // tests that live outside `db/**`, and it is a list a human must extend. A
    // future db-backed test under `src/**` that is not named here reproduces this
    // exact defect — collected by `vitest.config.ts`, skipped in `verify`, never
    // executed anywhere. That is the trade this entry makes: an explicit registry
    // that cannot silently expand, instead of a glob that silently widens the job.
    // EXTENDING B35's REGISTRY, NOT REPLACING IT (B37). B35 (dbbb67a) created
    // this named-file registry and documented, in this file, that it "is a list
    // a human must extend" — then the very next db-backed test under `src/**`
    // reproduced its own defect. `src/lib/db/__tests__/client.test.ts` carries
    // three `describeWithDb` assertions, one of which ("round-trips a row
    // through the migrated table") is the ONLY assertion anywhere that the
    // shipped `db/migrations` actually yields a usable table. Collected only by
    // `vitest.config.ts`, whose `verify` job has no database, all three reported
    // as SKIPPED inside a green run.
    //
    // THE CLASS IS NOW CLOSED BY A GUARD, NOT BY DISCIPLINE. The hand-maintained
    // list stays — it is the reason `composition-root.test.ts` is not dragged in
    // — but `src/__tests__/db-suite-registry.test.ts` fails the DEFAULT suite if
    // any `*.test.ts` under `src/**` requires a database and is absent from this
    // list. So this list can now only be wrong loudly.
    include: [
      "db/**/__tests__/**/*.test.ts",
      "src/app/sources/__tests__/persist-canonical-events-upsert.test.ts",
      "src/lib/db/__tests__/client.test.ts",
    ],
    // Serial: the suite inserts into one shared local table.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
