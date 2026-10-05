/**
 * T19 (b): the four auth tables EXIST IN POSTGRES after `bun run db:migrate`.
 *
 * This is the assertion the card calls out as the one a sibling card had to add a
 * registry entry for: not that a migration file exists, but that applying it
 * yields usable tables. It therefore does not assert on the Drizzle schema
 * object (which is what the offline suite in `src/lib/__tests__/` can see) — it
 * asks `information_schema` about the live database.
 *
 * IT CREATES ITS OWN DATABASE. `vitest.db.setup.ts` only requires that
 * `DATABASE_URL` point at a reachable Postgres; it does not promise that database
 * has had the migrations applied. Rather than depend on the ambient database's
 * state — which differs between a developer's machine, CI and a reviewer's
 * worktree, and is the reason B37's live-Postgres block never ran in any CI job —
 * this suite derives a dedicated database name from its own process id, creates
 * it, applies the real `db/migrations` folder to it through the real migrator, and
 * asserts against that. It drops the database in `afterAll`.
 *
 * `DATABASE_URL` is used ONLY as an admin connection template (host, port,
 * credentials). No credential is hardcoded anywhere: if `DATABASE_URL` is unset
 * this suite fails loudly via the setup file rather than skipping.
 *
 * The secret used by the auth instance here is generated per run and never
 * written anywhere.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { account, session, user, verification } from "../schema";
import { createAuth } from "../../src/lib/auth";

/** Tables and the columns Better Auth's own schema differ requires. */
const EXPECTED_TABLES: Record<string, readonly string[]> = {
  user: [
    "id",
    "name",
    "email",
    "emailVerified",
    "image",
    "createdAt",
    "updatedAt",
  ],
  session: [
    "id",
    "token",
    "expiresAt",
    "createdAt",
    "updatedAt",
    "ipAddress",
    "userAgent",
    "userId",
  ],
  account: [
    "id",
    "accountId",
    "providerId",
    "userId",
    "accessToken",
    "refreshToken",
    "idToken",
    "accessTokenExpiresAt",
    "refreshTokenExpiresAt",
    "scope",
    "password",
    "createdAt",
    "updatedAt",
  ],
  verification: [
    "id",
    "identifier",
    "value",
    "expiresAt",
    "createdAt",
    "updatedAt",
  ],
};

const adminUrl = process.env.DATABASE_URL;
if (!adminUrl) {
  throw new Error(
    "DATABASE_URL is not set; this suite needs an admin connection.",
  );
}

/** A database name unique to this process, so parallel runs never collide. */
const DB_NAME = `devloop_t19_auth_${process.pid}`;

/**
 * The admin connection with the database name swapped out. Written as text rather
 * than by parsing with `new URL()` because a Postgres URL carries the database as
 * its PATH, and `URL.pathname` would drop it if the URL were ever relative.
 */
function adminUrlFor(database: string): string {
  const url = new URL(adminUrl as string);
  url.pathname = `/${database}`;
  return url.toString();
}

let admin: ReturnType<typeof postgres>;

beforeAll(async () => {
  admin = postgres(adminUrlFor("postgres"), { max: 1, connect_timeout: 5 });
  // If a previous run of this process died before its afterAll, the name is
  // already taken; drop it so the CREATE below cannot fail spuriously.
  await admin.unsafe(`DROP DATABASE IF EXISTS "${DB_NAME}"`);
  await admin.unsafe(`CREATE DATABASE "${DB_NAME}"`);
}, 60_000);

afterAll(async () => {
  await admin?.unsafe(`DROP DATABASE IF EXISTS "${DB_NAME}"`);
  await admin?.end();
});

/** Live column names for one table, from Postgres rather than from the schema. */
async function liveColumns(
  client: postgres.Sql,
  table: string,
): Promise<string[]> {
  const rows = await client<
    Array<{ column_name: string }>
  >`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${table} ORDER BY ordinal_position`;
  return rows.map((row) => row.column_name);
}

describe("Better Auth tables after bun run db:migrate", () => {
  let client: postgres.Sql;

  beforeAll(async () => {
    client = postgres(adminUrlFor(DB_NAME), { max: 1, connect_timeout: 5 });
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: "./db/migrations" });
  }, 120_000);

  afterAll(async () => {
    await client?.end();
  });

  /**
   * c8b, the load-bearing case: every table exists AND every column Better Auth's
   * schema differ requires is present in the live database.
   *
   * The column list is asserted as a SET of the expected names, not as an exact
   * list, because `diffSchema` also rejects `unexpected-required-column` — a
   * column that is NOT NULL with no default that Better Auth never writes would
   * break every insert while a presence-only assertion stayed green.
   */
  it.each(Object.entries(EXPECTED_TABLES))(
    "creates table %s with every column Better Auth writes",
    async (table, columns) => {
      expect(await liveColumns(client, table)).toEqual(
        expect.arrayContaining([...columns]),
      );
    },
  );

  it("reports all four tables to information_schema", async () => {
    const rows = await client<
      Array<{ table_name: string }>
    >`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`;
    const names = rows.map((row) => row.table_name);
    for (const table of Object.keys(EXPECTED_TABLES)) {
      expect(names).toContain(table);
    }
  });

  /**
   * No table Better Auth writes may carry a column it never fills that is NOT
   * NULL and has no default: the adapter's own `diffSchema` reports that as
   * `unexpected-required-column` and every insert into the table then fails.
   * Asserting it here catches the shape BEFORE a request does.
   */
  it("has no NOT NULL column that Better Auth never writes", async () => {
    const written: Record<string, ReadonlySet<string>> = Object.fromEntries(
      Object.entries(EXPECTED_TABLES).map(([table, columns]) => [
        table,
        new Set(["id", ...columns]),
      ]),
    );
    const rows = await client<
      Array<{
        table_name: string;
        column_name: string;
        is_nullable: string;
        has_default: boolean;
      }>
    >`SELECT table_name, column_name, is_nullable, column_default IS NOT NULL AS has_default
       FROM information_schema.columns
      WHERE table_schema = 'public' AND is_nullable = 'NO'`;

    const offending = rows
      .filter(
        (row) =>
          written[row.table_name] !== undefined &&
          !written[row.table_name]!.has(row.column_name) &&
          row.has_default !== true,
      )
      .map((row) => `${row.table_name}.${row.column_name}`);

    expect(
      offending,
      `columns Better Auth never writes: ${offending.join(", ")}`,
    ).toEqual([]);
  });

  /**
   * The tables are USABLE, not merely present: a foreign key and a unique
   * constraint only prove anything if Postgres enforces them.
   */
  it("enforces the session->user foreign key", async () => {
    await expect(
      client`INSERT INTO "session" ("id","token","expiresAt","createdAt","updatedAt","userId") VALUES ('s1','t1', now(), now(), now(), 'no-such-user')`,
    ).rejects.toThrow(/foreign key/i);
  });

  it("enforces the account->user foreign key", async () => {
    await expect(
      client`INSERT INTO "account" ("id","accountId","providerId","userId","createdAt","updatedAt") VALUES ('a1','x','credential','no-such-user', now(), now())`,
    ).rejects.toThrow(/foreign key/i);
  });

  it("enforces unique session tokens", async () => {
    await client`INSERT INTO "user" ("id","name","email","createdAt","updatedAt") VALUES ('u1','A','a@example.invalid', now(), now())`;
    await client`INSERT INTO "session" ("id","token","expiresAt","createdAt","updatedAt","userId") VALUES ('s1','tok', now(), now(), now(), 'u1')`;
    await expect(
      client`INSERT INTO "session" ("id","token","expiresAt","createdAt","updatedAt","userId") VALUES ('s2','tok', now(), now(), now(), 'u1')`,
    ).rejects.toThrow(/unique/i);
  });

  /**
   * The end-to-end wiring claim: an auth instance built over the migrated
   * database signs a user up, and the row lands in the table this migration
   * created. Without this the cases above only prove DDL.
   *
   * `createAuth` is used with an explicit client and an explicit throwaway secret,
   * so nothing here reads a developer's `.env` or touches the shared pooled
   * client in `src/lib/db/client.ts`.
   */
  it("signs a user up through the adapter and persists it to the user table", async () => {
    const db = drizzle(client, {
      schema: { user, session, account, verification },
    });
    const auth = createAuth(
      `test-only-${process.pid}-${Date.now()}-${Math.random()}`,
      db,
      "http://localhost:3000",
    );

    const email = "t19-signup@example.invalid";
    const result = await auth.api.signUpEmail({
      body: { email, password: "correct-horse-battery-staple", name: "T19" },
    });

    expect(result.user.email).toBe(email);
    expect(result.user.emailVerified).toBe(false);
    // The password hash, not the password, and the row exists where it must.
    const rows = await client<
      Array<{ password: string | null; providerId: string }>
    >`
      SELECT "password", "providerId" FROM "account" WHERE "userId" = ${result.user.id}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.password).toBeTruthy();
    expect(rows[0]?.password).not.toContain("correct-horse-battery-staple");
    // Better Auth's local-credentials provider is the one it owns internally;
    // this asserts no EXTERNAL provider is configured.
    expect(rows[0]?.providerId).toBe("credential");
  });
});
