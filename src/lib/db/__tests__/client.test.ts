/**
 * Connection-check tests.
 *
 * IMPORTANT (T5): the database-backed describe block SKIPS when DATABASE_URL is
 * unset. T2's CI workflow runs `bun run test` with no secrets and no database,
 * so a hard failure here would turn CI permanently red for a reason unrelated to
 * the code. Skipping is the correct behaviour, not a weakened test.
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
    // Guarded on DATABASE_URL because getDb() reads it. drizzle() does not
    // connect eagerly, so this asserts caching only, never a live connection.
    if (!connectionString) return;
    await withDatabaseUrl(connectionString, async () => {
      expect(getDb()).toBe(getDb());
    });
  });
});

describe("checkDatabaseConnection", () => {
  it("returns ok:false instead of throwing when the database is unreachable", async () => {
    // Port 1 is reserved and never listening. Derived from DATABASE_URL so no
    // host, port or credential is hardcoded in the repo.
    const unreachable = new URL(
      connectionString ?? "postgresql://localhost/devloop",
    );
    unreachable.hostname = "127.0.0.1";
    unreachable.port = "1";
    unreachable.username = "";
    unreachable.password = "";
    unreachable.pathname = "/nonexistent";
    await withDatabaseUrl(unreachable.toString(), async () => {
      const result = await checkDatabaseConnection();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBeTypeOf("string");
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
