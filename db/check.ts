/**
 * Server-side connection check: runs `SELECT 1` against the local Postgres and
 * prints a human-readable result. Exits 1 on failure so it can gate a script.
 */

import { checkDatabaseConnection } from "../src/lib/db/client";

const result = await checkDatabaseConnection();

if (result.ok) {
  console.log(`db:check — connected (SELECT 1 => ${result.result}).`);
  process.exit(0);
}

console.error(`db:check — FAILED: ${result.error}`);
process.exit(1);
