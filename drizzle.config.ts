/**
 * Drizzle Kit configuration.
 *
 * The connection string is read from DATABASE_URL only — no credential, host,
 * port or database name is hardcoded anywhere in this repo. `drizzle.config.ts`
 * falls back to an empty string so that `db:generate` (a purely offline
 * operation that reads schema files and diffs them) still works with no
 * database configured; `db:migrate` requires DATABASE_URL to be set.
 */

import type { Config } from "drizzle-kit";

export default {
  schema: "./db/schema.ts",
  out: "./db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
  strict: true,
  verbose: true,
} satisfies Config;
