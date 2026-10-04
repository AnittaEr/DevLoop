/**
 * Applies the generated SQL migrations in db/migrations to the local Postgres.
 *
 * Intentionally separate from drizzle.config.ts's `migrate` so that a missing
 * DATABASE_URL produces a clear message instead of a driver-level stack trace.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error(
    "DATABASE_URL is not set. Copy .env.example to .env and point it at your local Postgres.",
  );
  process.exit(1);
}

const client = postgres(connectionString, { max: 1, connect_timeout: 5 });

try {
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: "./db/migrations" });
  console.log("db:migrate — migrations applied successfully.");
} finally {
  await client.end();
}
