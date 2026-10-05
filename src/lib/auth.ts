/**
 * The Better Auth instance for DevLoop (T19).
 *
 * SCOPE: plumbing only. This module constructs the instance, points it at the
 * Drizzle adapter and the four auth tables in `db/schema.ts`, and reads two
 * environment variables. It contains NO sign-in/sign-up UI and NO middleware —
 * protecting routes is a later card.
 *
 * WHY THE SECRET IS READ HERE AND NEVER STORED. `BETTER_AUTH_SECRET` is required
 * and is deliberately NOT given a fallback: a silent default would let the app
 * boot signing cookies with a well-known key, which is exactly the failure a
 * local app is easiest to miss. The variable NAME is documented in
 * `.env.example`; no value is ever written to a file in this repo and no test
 * reads a real one — tests inject a throwaway value.
 *
 * WHY DEVLOOP ENFORTS IT ITSELF, AT REQUEST TIME. Measured against 1.7.7:
 * Better Auth resolves `options.secret || env.BETTER_AUTH_SECRET ||
 * env.AUTH_SECRET` and, when that is empty, falls back to the published
 * literal `better-auth-secret-12345678901234567890`
 * (`dist/context/create-context.mjs`). Its own rejection of that literal fires
 * ONLY under `NODE_ENV=production` — and v1 has no deployment (hard rule 7),
 * so the mode DevLoop actually runs in is the one where the library accepts the
 * public key. So `requireAuthSecret()` below is the refusal, and the route
 * handlers call it before Better Auth sees a request. It is deliberately not a
 * module-scope throw: `next build` and `bun run test` both import this module
 * with no `.env`.
 *
 * `BETTER_AUTH_URL` is the base URL Better Auth derives cookie domain, redirects
 * and the `/api/auth/*` mount point from. It defaults to `http://localhost:3000`,
 * the Next.js dev port, so `bun run dev` works with no extra configuration.
 *
 * WHY THE DB CLIENT IS RESOLVED LAZILY. `src/lib/db/client.ts`'s `getDb()` reads
 * `DATABASE_URL` on first use and THROWS when it is unset. Importing this module
 * therefore must not require a database — only *using* the instance must.
 * `next build` imports every route module with no DATABASE_URL and no running
 * Postgres, and so does `bun run test`; calling `getDb()` at module scope would
 * make both fail for a reason that has nothing to do with auth. `lazyDrizzleClient`
 * below defers the call to the first actual statement the adapter issues.
 *
 * WHY `advanced.database.joins` IS LEFT OFF. It requires Drizzle `relations()`
 * definitions, which DevLoop does not declare for these tables; leaving it off is
 * the documented default and cannot half-enable.
 *
 * WHY TELEMETRY IS DISABLED EXPLICITLY. `telemetry.enabled` already defaults to
 * false in 1.7.7. Setting it explicitly means a future library default change
 * cannot silently start sending data out of a local-only app (D2, hard rule 7).
 */

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { DB, DrizzleAdapterConfig } from "better-auth/adapters/drizzle";

import { getDb } from "./db/client";
import * as authSchema from "../../db/schema";

/**
 * The four tables the adapter reads, named as Better Auth's default singular
 * `modelName`s (`user`, not `users` — `usePlural` is deliberately not set, so
 * these exported names are load-bearing).
 *
 * Spelled out rather than spread over `* as authSchema` so the contract is
 * visible: `getSchema(model)` looks the table up by exactly this key and throws
 * "The model was not found in the schema object" if one is renamed.
 */
export const AUTH_SCHEMA: NonNullable<DrizzleAdapterConfig["schema"]> = {
  user: authSchema.user,
  session: authSchema.session,
  account: authSchema.account,
  verification: authSchema.verification,
};

export const DEFAULT_BASE_URL = "http://localhost:3000";

/**
 * The secret DevLoop requires, or `undefined` when the environment has none.
 *
 * Never logs, never returns a fallback, and is the non-throwing accessor the
 * test suite and any future health check should use to ask the question.
 *
 * The value is NEVER written to a file in this repo, logged, or committed. See
 * `.env.example` for the variable NAME.
 */
export function readAuthSecret(): string | undefined {
  return process.env.BETTER_AUTH_SECRET;
}

/**
 * The `BETTER_AUTH_URL` override, or `undefined` when there is none to honour.
 *
 * SEPARATE FROM `readAuthSecret` ON PURPOSE, because the two variables fail in
 * the same way and one of them had been fixed while the other had not. An EMPTY
 * value counts as unset for both: `.env.example` ships `BETTER_AUTH_SECRET=` and
 * `BETTER_AUTH_URL=` empty and instructs the operator to copy the file as-is, so
 * `""` is the state a correct setup actually produces. `requireAuthSecret()`
 * treats `""` as unset (see its note); this makes the URL do the same rather than
 * resolving a base URL of `""` and leaving Better Auth to warn and derive the
 * origin from the request (QA round 2, D4).
 *
 * Whitespace is trimmed and a whitespace-only value counts as unset, because
 * dotenv lines are commonly written with trailing spaces and `BETTER_AUTH_URL= `
 * would otherwise reach the library as an unusable URL.
 *
 * Never returns an empty string, so callers can use `??` on the result.
 */
function readBaseURLOverride(): string | undefined {
  const configured = process.env.BETTER_AUTH_URL?.trim();
  return configured === undefined || configured === "" ? undefined : configured;
}

/**
 * The published literal `better-auth` falls back to when no secret is set.
 *
 * Named here rather than imported from the library because it is a private
 * constant (`dist/utils/constants.mjs`, `DEFAULT_SECRET`) with no public export.
 * Duplicating it is what makes the refusal below a test of DEVLOOP's own check
 * rather than a round trip through the library. If a future release changes its
 * default this stops matching and the second refusal stops firing — a false
 * negative, not a false positive, so it fails in the safe direction.
 */
const BETTER_AUTH_PUBLISHED_DEFAULT_SECRET =
  "better-auth-secret-12345678901234567890";

/**
 * Thrown when auth cannot safely run because the secret is missing or default.
 *
 * A distinct class so the route answers a deliberate 503 rather than an opaque
 * 500: this is a configuration error the operator must fix, not a crash.
 * The message names the VARIABLE and never the value.
 */
export class AuthSecretMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthSecretMissingError";
  }
}

/**
 * Fails closed unless a real `BETTER_AUTH_SECRET` is configured.
 *
 * CALLED AT REQUEST TIME, from the `[...all]` route handlers, never at module
 * scope: `next build` imports route modules with no `.env`, and so does
 * `bun run test`, and neither should have to have one.
 *
 * It rejects a missing secret AND the library's published default, because
 * Better Auth's own check (`create-context.mjs` -> `validateSecret`) throws only
 * under `NODE_ENV=production`, which is the mode v1 never runs in (hard rule 7:
 * no deployment). Left to the library alone, a local run with no `.env` signs
 * cookies with a key published in the library's own source.
 *
 * Length validation is deliberately NOT duplicated — that belongs to the
 * library, and re-implementing it would reject values the library accepts.
 *
 * THE VALUE IS NEVER IN THE MESSAGE, so this is safe to log or return.
 */
export function requireAuthSecret(): string {
  const secret = readAuthSecret();

  if (secret === undefined || secret === "") {
    throw new AuthSecretMissingError(
      "BETTER_AUTH_SECRET is not set. Auth cookies cannot be signed without it. " +
        "Copy .env.example to .env and set the variable (openssl rand -base64 32). " +
        "DevLoop deliberately ships no default secret.",
    );
  }

  if (secret === BETTER_AUTH_PUBLISHED_DEFAULT_SECRET) {
    throw new AuthSecretMissingError(
      "BETTER_AUTH_SECRET is set to Better Auth's published default secret, which is " +
        "publicly known and therefore signs forgeable auth cookies. Replace it with a " +
        "generated value (openssl rand -base64 32).",
    );
  }

  return secret;
}

/**
 * The database value Better Auth's `database` option accepts when it is given a
 * drizzle adapter.
 *
 * It is the adapter's own exported `DB` type rather than `ReturnType<typeof getDb>`:
 * `DB` is `{ [key: string]: any }`, so it accepts any drizzle client over any
 * schema. `getDb()`'s return type instead names THIS repo's full schema, which
 * made `createAuth` reject a client built over a subset — exactly what the
 * db-backed suite legitimately passes. Narrowing the parameter to one caller's
 * schema would have been a type-level lie in the other direction: `lazyDrizzleClient`
 * returns a proxy that satisfies `DB` but is not assignable to that schema-bound
 * type, and the proxy is what keeps `next build` working without a database.
 */
type AuthDatabase = DB;

/**
 * A Drizzle client whose first property access resolves the real one.
 *
 * The drizzle adapter touches the client only when it builds or runs a
 * statement — `db._.fullSchema` for its own schema check, `db.select()`,
 * `db.transaction()` — never when `drizzleAdapter(db, config)` is called. A
 * property-forwarding proxy therefore defers `getDb()` (and its
 * "DATABASE_URL is not set" throw) past module initialisation without changing
 * any behaviour after that point.
 *
 * MEASURED, not assumed: returning the resolved `getDb()` at module scope, or
 * removing this indirection, fails `next build` with
 * `Failed to collect page data for /api/auth/[...all]`, because the build imports
 * route modules with no `DATABASE_URL` and no running Postgres.
 *
 * Method reads are rebound to the resolved client: Drizzle's query builders
 * hold `this`, so a forwarded method called on the proxy would otherwise look up
 * its state on the proxy and find nothing.
 */
function lazyDrizzleClient(): AuthDatabase {
  return new Proxy({} as AuthDatabase, {
    get(_target, property) {
      const db = getDb() as unknown as Record<PropertyKey, unknown>;
      const value = db[property];
      return typeof value === "function" ? value.bind(db) : value;
    },
  }) as AuthDatabase;
}

/** Adapter configuration shared by the app instance and the test factory. */
export function authAdapterConfig(): DrizzleAdapterConfig {
  return {
    provider: "pg",
    schema: AUTH_SCHEMA,
  };
}

/**
 * The options every DevLoop auth instance is built from, minus the two
 * environment-specific bindings (the database client and the secret).
 *
 * EXTRACTED SO THE SHIPPED INSTANCE IS ASSERTABLE. Round 1 review (D3) removed
 * `baseURL` and the entire `emailAndPassword` block from the module-scope
 * instance and both suites stayed green, because the offline test hand-rolled
 * its own `betterAuth({...})` instead of exercising the options DevLoop
 * actually ships. One definition, used by `createAuth` and by the app instance,
 * means `src/lib/__tests__/auth-instance.test.ts` can assert against
 * `auth.options` — the object `toNextJsHandler(auth.handler)` mounts — instead of
 * against a lookalike.
 *
 * `baseURL` is read here rather than inlined so `BETTER_AUTH_URL` override and
 * the default live in one place; `DEFAULT_BASE_URL` is what the default is.
 *
 * WHY THE OVERRIDE GOES THROUGH `readBaseURLOverride`. QA round 2 (D4) measured
 * the documented default never reaching the operator: `.env.example` ships
 * `BETTER_AUTH_URL=` EMPTY and its own header says "COPY TO .env AND FILL IN",
 * so the documented path (`cp .env.example .env`) produces `""`, not
 * `undefined`. `??` falls back only on null/undefined, so `baseURL` resolved to
 * `""` and Better Auth logged "Base URL is not set" and derived the origin from
 * the incoming request. An EMPTY value is the state the example file actually
 * produces, so it must be treated as unset here exactly as `requireAuthSecret`
 * already treats `BETTER_AUTH_SECRET=""` as unset in the same module — the
 * asymmetry was the defect. `??` stays HERE, at the single point where the
 * default is applied, because the helper's whole job is to normalise "unset" to
 * `undefined` without inventing a value.
 */
export function authBaseOptions(): {
  appName: string;
  baseURL: string;
  emailAndPassword: { enabled: true };
  telemetry: { enabled: false };
} {
  return {
    appName: "DevLoop",
    baseURL: readBaseURLOverride() ?? DEFAULT_BASE_URL,
    emailAndPassword: {
      enabled: true,
    },
    telemetry: {
      enabled: false,
    },
  };
}

/**
 * Builds an auth instance against a caller-supplied client and secret.
 *
 * The database and secret are parameters, not ambient reads, so a test can
 * construct a real instance against its own throwaway database and throwaway
 * secret without mutating `process.env` or the shared pooled client.
 *
 * Used by the db-backed suite, which must sign a real user up against a real
 * Postgres. It deliberately takes the secret as a parameter and therefore does
 * not go through `requireAuthSecret` — a test supplies its own throwaway secret,
 * and re-reading the ambient environment here would make the test depend on the
 * shell it runs in.
 */
export function createAuth(
  secret: string,
  database: AuthDatabase,
  baseURL?: string,
) {
  return betterAuth({
    ...authBaseOptions(),
    ...(baseURL === undefined ? {} : { baseURL }),
    secret,
    database: drizzleAdapter(database, authAdapterConfig()),
  });
}

/**
 * The request-time auth instance used by the `[...all]` route and the session
 * helper.
 *
 * TWO THINGS ARE DELIBERATELY NOT PASSED HERE:
 *
 *   - `secret`. Better Auth resolves `options.secret || env.BETTER_AUTH_SECRET`
 *     itself (`create-context.mjs`), so the module-scope instance can leave it to
 *     the library and stay importable with no `.env`. The refusal that the
 *     library only applies under `NODE_ENV=production` is `requireAuthSecret()`,
 *     which the route calls at REQUEST time — see its note for why not module
 *     scope.
 *
 *   - a resolved database. `getDb()` throws when `DATABASE_URL` is unset, and
 *     this module is imported by `next build` and by `bun run test`, neither of
 *     which has one. `lazyDrizzleClient` defers that first touch to the first
 *     statement the adapter actually issues.
 */
export const auth = betterAuth({
  ...authBaseOptions(),
  database: drizzleAdapter(lazyDrizzleClient(), authAdapterConfig()),
});
