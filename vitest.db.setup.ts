/**
 * Setup for the DB-backed integration suite (`bun run test:db`).
 *
 * DELIBERATELY NOT SKIP-SAFE. A round-trip test that quietly skips when no
 * database is reachable is indistinguishable from one that passed, and this
 * suite exists to prove a real type -> storage -> type round trip. If
 * DATABASE_URL is unset the suite throws here rather than reporting green.
 */

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set. The DB integration suite requires a real Postgres; " +
      "run it with DATABASE_URL pointing at your local Postgres after `bun run db:migrate`. " +
      "This suite is intentionally not skip-safe.",
  );
}
