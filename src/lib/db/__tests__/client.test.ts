/**
 * Connection-check tests.
 *
 * The database-backed describe block SKIPS when DATABASE_URL is
 * unset. T2's CI workflow runs `bun run test` with no secrets and no database,
 * so a hard failure here would turn CI permanently red for a reason unrelated to
 * the code. Skipping is the correct behaviour, not a weakened test.
 *
 * IT IS NOT ONLY EVER SKIPPED (B37, t_8c73ba34). This file is named explicitly in
 * `vitest.db.config.ts`'s include list, so `bun run test:db` collects it too, and
 * the `db round trip` CI job runs it against a real Postgres with the migrations
 * applied. In THAT job all three assertions below execute for real rather than
 * reporting skipped — measured 13 -> 19 tests in `bun run test:db`, the 6 new
 * ones being this file's. The skip above is the database-less configuration
 * only.
 *
 * No test in this file early-returns before its assertions: every `it` runs at
 * least one real `expect`. T5a removed the `if (!connectionString) return;`
 * guard that let the singleton test report PASSED with zero assertions in the
 * DATABASE_URL-unset configuration.
 *
 * The skip decision is captured at module load; the tests below that mutate
 * DATABASE_URL call closeDb() so the lazy client re-reads the env.
 */

import { afterAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

import { appMeta } from "../../../../db/schema";
import { checkDatabaseConnection, closeDb, getDb } from "../client";

const connectionString = process.env.DATABASE_URL;
const describeWithDb = connectionString ? describe : describe.skip;

/**
 * A syntactically valid but unlistening Postgres URL, derived from DATABASE_URL
 * when present so no host, port or credential is hardcoded in the repo. Port 1 is
 * reserved and never listening.
 *
 * Used wherever a test needs a real connection string in the DATABASE_URL-unset
 * configuration: drizzle() connects lazily, so asserting on the client object
 * never touches the network.
 */
function unreachableUrl(): string {
  const url = new URL(connectionString ?? "postgresql://localhost/devloop");
  url.hostname = "127.0.0.1";
  url.port = "1";
  url.username = "";
  url.password = "";
  url.pathname = "/nonexistent";
  return url.toString();
}

async function withDatabaseUrl(
  value: string | undefined,
  run: () => Promise<void>,
) {
  const previous = process.env.DATABASE_URL;
  if (value === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = value;
  // The client is lazily cached: drop it so it re-reads the env we just set.
  await closeDb();
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
    await closeDb();
  }
}

describe("getDb", () => {
  it("throws a helpful error when DATABASE_URL is unset", async () => {
    await withDatabaseUrl(undefined, async () => {
      // getDb throws synchronously, so wrap it before asserting on the throw.
      expect(() => getDb()).toThrow(/DATABASE_URL/);
    });
  });

  it("returns the same instance on repeated calls (lazy singleton)", async () => {
    // Runs unconditionally. drizzle() connects lazily, so a syntactically valid
    // but unlistening URL is enough to observe caching identity — no server is
    // contacted. When DATABASE_URL is set we use it as-is; when it is unset we
    // use unreachableUrl(), which keeps this a real assertion in CI where no
    // DATABASE_URL exists. T5a: this previously early-returned here, so CI
    // reported the test passed with zero assertions executed.
    await withDatabaseUrl(connectionString ?? unreachableUrl(), async () => {
      expect(getDb()).toBe(getDb());
      // Distinct call sites must yield the identical cached object, and calling
      // again after construction must not throw (laziness stays intact).
      expect(getDb()).toBe(getDb());
      expect(getDb()).not.toBe(undefined);
    });
  });
});

describe("checkDatabaseConnection", () => {
  it("returns ok:false instead of throwing when the database is unreachable", async () => {
    // Port 1 is reserved and never listening. Derived from DATABASE_URL so no
    // host, port or credential is hardcoded in the repo.
    await withDatabaseUrl(unreachableUrl(), async () => {
      const result = await checkDatabaseConnection();
      expect(result.ok).toBe(false);
      // T5a: the driver failure is wrapped by Drizzle, so a bare error.message
      // would read only "Failed query: SELECT 1::int AS one". The reported
      // string must therefore carry the underlying cause for db:check to be
      // actionable when the local Postgres is simply not running.
      if (result.ok) throw new Error("unreachable: expected ok:false");
      expect(result.error).toContain("caused by:");
      expect(result.error).toMatch(/ECONNREFUSED|connect /i);
    });
  });
});

describeWithDb("checkDatabaseConnection (live local Postgres)", () => {
  it("returns ok:true with SELECT 1 => 1", async () => {
    const result = await checkDatabaseConnection();
    expect(result).toEqual({ ok: true, result: 1 });
  });

  it("really executes SQL — the app_meta table from db/migrations exists", async () => {
    const rows = await getDb().execute<{ table_name: string }>(
      sql`SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'app_meta'`,
    );
    expect(rows.map((row) => row.table_name)).toContain("app_meta");
  });

  it("round-trips a row through the migrated table", async () => {
    const db = getDb();
    await db
      .insert(appMeta)
      .values({ key: "t5:probe", value: "ok" })
      .onConflictDoNothing();
    const found = await db
      .select()
      .from(appMeta)
      .where(eq(appMeta.key, "t5:probe"));
    expect(found[0]?.value).toBe("ok");
    await db.delete(appMeta).where(eq(appMeta.key, "t5:probe"));
  });
});

afterAll(async () => {
  await closeDb();
});
