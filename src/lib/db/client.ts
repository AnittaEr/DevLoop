/**
 * Lazily-initialised Drizzle client for the local Postgres instance.
 *
 * DevLoop is local-only in v1 (D2): there is no hosted database. The connection
 * string comes from DATABASE_URL and nothing else — no password, host or port is
 * hardcoded here or anywhere else in the repo.
 */

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "../../../db/schema";

export type Database = PostgresJsDatabase<typeof schema>;

/** Single pooled connection: DevLoop is a single-user local app. */
const POOL = { max: 1 } as const;
/** Fail fast instead of hanging a request when Postgres is not running. */
const CONNECT_TIMEOUT_SECONDS = 5;

let cached: Database | undefined;
let cachedClient: postgres.Sql | undefined;

/**
 * Returns the process-wide Drizzle client, creating it on first use.
 *
 * Throws if DATABASE_URL is unset — importing this module must not require a
 * database, only *using* the client does.
 */
export function getDb(): Database {
  if (cached) return cached;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env and point it at your local Postgres.",
    );
  }
  cachedClient = postgres(connectionString, {
    ...POOL,
    connect_timeout: CONNECT_TIMEOUT_SECONDS,
  });
  cached = drizzle(cachedClient, { schema });
  return cached;
}

/** Closes the pooled connection, if one was opened. Safe to call when unused. */
export async function closeDb(): Promise<void> {
  await cachedClient?.end();
  cachedClient = undefined;
  cached = undefined;
}

export type DatabaseConnectionCheck =
  | { ok: true; result: number }
  | { ok: false; error: string };

/**
 * Trivial round-trip to the database (`SELECT 1`). Never throws: returns a
 * discriminated result so callers and tests can assert on failure without an
 * unhandled exception.
 */
export async function checkDatabaseConnection(): Promise<DatabaseConnectionCheck> {
  try {
    const rows = await getDb().execute<{ one: number }>(
      sql`SELECT 1::int AS one`,
    );
    return { ok: true, result: Number(rows[0]?.one ?? 0) };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

/**
 * Renders a caught error for humans, including the underlying cause.
 *
 * Drizzle wraps the driver failure, so `error.message` alone is frequently just
 * "Failed query: SELECT 1::int AS one" — the actual reason (ECONNREFUSED,
 * password authentication failed, unknown database) only lives on
 * `error.cause`. Without appending the cause, `db:check` cannot tell the
 * developer what actually went wrong.
 *
 * The parenthesised form is emitted only when there is a code to put inside the
 * parentheses. A cause with no `.code` was previously given a bare trailing `)`
 * with no matching `(` — T6b. Not every driver error carries a code, so the
 * code-less form is the common case, not the exotic one.
 */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: unknown }).cause;
  const code = cause instanceof Error ? codeOf(cause) : "";
  const causeText =
    cause instanceof Error
      ? code
        ? `${cause.message} (${code})`
        : cause.message
      : cause === undefined
        ? ""
        : String(cause);
  if (!causeText) return error.message;
  return `${error.message} — caused by: ${causeText}`;
}

/** Node system errors (ECONNREFUSED, ENOTFOUND, ...) carry a `code`. */
function codeOf(error: Error): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : "";
}
