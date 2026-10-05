/**
 * T19 (QA round 3, D5): the session helper must not accept a session forged with
 * Better Auth's PUBLISHED DEFAULT secret.
 *
 * THE DEFECT THIS FILE EXISTS FOR. `requireAuthSecret()` had exactly one
 * production caller — the `[...all]` route handlers. `src/lib/auth-session.ts`
 * reads the SAME module-scope instance, which deliberately does not pass
 * `secret`, so with no `.env` (the default local state, and exactly what
 * `cp .env.example .env` produces) that instance resolved `secret` to the literal
 * published in Better Auth's own source. QA measured the consequence against a
 * real Postgres: a cookie forged with that key was ACCEPTED and `getSession()`
 * returned the forged session's user. The route guard covered `/api/auth/*` and
 * nothing else.
 *
 * WHY THIS IS DB-BACKED AND NOT OFFLINE. The property is an ACCEPTANCE: does the
 * read path return a session for this cookie or not. Asserting that needs a real
 * user row, a real session row, and a real signature check — a mocked database
 * would let the assertion pass for reasons that have nothing to do with the defect.
 * So this file creates its own database, applies the real migrations, and drives
 * the SHIPPED `getSession()`.
 *
 * THE COOKIE IS BUILT WITH THE LIBRARY'S OWN SIGNER. `serializeSignedCookie` from
 * `better-call` is exactly what `ctx.setSignedCookie` calls internally
 * (`better-call/dist/context.mjs` -> `cookies.mjs` -> `signCookieValue`). A
 * hand-rolled HMAC would make a rejection meaningless: QA's first probe
 * hand-rolled one, reported `ACCEPTED: false`, and that answer was wrong —
 * a rejection from a guessed cookie format proves nothing about acceptance.
 * So the forged cookie here is byte-for-byte what the library would emit.
 *
 * ITS OWN DATABASE, ITS OWN SECRET. Same discipline as `auth-tables.test.ts`: the
 * ambient `DATABASE_URL` is only an admin connection template, and every secret
 * here is generated per run. Nothing is written to a file.
 */

import { spawnSync } from "node:child_process";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { serializeSignedCookie } from "better-call";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as authSchema from "../schema";

/**
 * The cookie header the "request" carries. Mocked rather than driven through a
 * real server because the property under test is which value the READ path
 * accepts, and `getSession()`'s only coupling to the request is these headers —
 * it reads them with `next/headers`.
 */
let requestCookieHeader: string | undefined;

vi.mock("next/headers", () => ({
  headers: () =>
    Promise.resolve(new Headers({ cookie: requestCookieHeader ?? "" })),
}));

/**
 * The literal Better Auth falls back to when no secret is set: a PUBLIC string
 * from the library's own source. Naming it is the assertion — DevLoop must refuse
 * exactly this value.
 */
const PUBLISHED_DEFAULT = "better-auth-secret-12345678901234567890";

/**
 * The real, throwaway secret this run signs its honest cookie with. Generated per
 * run, held in memory only, and written to no file. It is NOT a credential for
 * anything: it signs cookies in a throwaway database that is dropped afterwards.
 */
const REAL_SECRET = `t19-forge-${process.pid}-${crypto.randomUUID()}`;

/**
 * THE SHIPPED INSTANCE'S SIGNING KEY IS FIXED AT ITS FIRST `$context` RESOLUTION,
 * not per request — measured, not assumed: `$context` is a memoised promise, so
 * `delete process.env.BETTER_AUTH_SECRET` followed by setting it to a real value
 * leaves `ctx.secret` at the published default.
 *
 * WHICH MEANS THE ENVIRONMENT MUST BE SET BEFORE `src/lib/auth` IS IMPORTED. The
 * assignment below sits ABOVE the `await import(...)` calls for exactly that
 * reason, and it is the one ordering constraint in this file: an earlier draft
 * imported first and got the published default pinned into the instance, which
 * INVERTED every assertion here — the forge was accepted and the honest cookie
 * refused. That inversion is the defect D5 describes, reproduced by ordering.
 *
 * AFTER THAT ASSIGNMENT the env can still be changed per test to exercise the
 * refusal path; that changes what `requireAuthSecret()` sees, which is what D5
 * was about. It no longer changes what the instance signs with.
 *
 * THIS IS ALSO WHY THE FORGE IS REFUSED HERE. The instance signs with
 * `REAL_SECRET`; the attacker's cookie is signed with the published default; the
 * keys differ, so it is refused. With no guard AND no configured secret they would
 * be the same key and the forge would be accepted. `accepts the honest session`
 * is the control that makes this a statement about the signing key rather than
 * about cookie parsing.
 */
process.env.BETTER_AUTH_SECRET = REAL_SECRET;

const { auth, AuthSecretMissingError, createAuth } = await import(
  "../../src/lib/auth"
);
const { getSession, isSignedIn } = await import("../../src/lib/auth-session");

const adminUrl = process.env.DATABASE_URL;
if (!adminUrl) {
  throw new Error(
    "DATABASE_URL is not set; this suite needs an admin connection.",
  );
}

const DB_NAME = `devloop_t19_forge_${process.pid}`;

function adminUrlFor(database: string): string {
  const url = new URL(adminUrl as string);
  url.pathname = `/${database}`;
  return url.toString();
}

const EMAIL = `t19-forge-${process.pid}@example.invalid`;
let client: postgres.Sql;
let admin: ReturnType<typeof postgres>;
let sessionToken: string;

/**
 * The ambient `DATABASE_URL` the setup file required, kept so it can be put back.
 *
 * The SHIPPED `auth` instance resolves its database through `getDb()`, which
 * reads `DATABASE_URL` once and caches the client — so the only way to point the
 * instance this file asserts about at a throwaway database is to set the variable
 * before the first statement the adapter issues. Restored in `afterAll` so no
 * later file in the same process inherits it.
 */
const ambientDatabaseUrl = process.env.DATABASE_URL;

/**
 * The cookie name the SHIPPED instance uses, read from the instance rather than
 * hardcoded — the prefix is Better Auth's to choose (`advanced.cookiePrefix`,
 * plus a `__Secure-` prefix off `baseURL`), and a hardcoded name would silently
 * make the forge miss and the test decorative.
 */
async function sessionCookieName(): Promise<string> {
  const ctx = await auth.$context;
  return (ctx as { authCookies: { sessionToken: { name: string } } })
    .authCookies.sessionToken.name;
}

/**
 * A SEPARATE instance, built with NO secret at all, which therefore resolves the
 * library's published default exactly as the shipped instance does when the
 * environment has none.
 *
 * This is the control that makes the guard provably load-bearing rather than
 * merely asserted. `createAuth(secret, database, baseURL)` always takes a secret,
 * so this passes an empty one — the library resolves
 * `options.secret || env.BETTER_AUTH_SECRET` and falls back to the published
 * literal, which it rejects only under `NODE_ENV=production`. If that unguarded
 * instance ACCEPTS a default-signed cookie where the guarded helper refuses, then
 * "the helper refused" is a fact about DevLoop's check and not an accident of the
 * signing key happening to differ.
 */
function unconfiguredAuth() {
  return createAuth("", drizzle(client, { schema: authSchema }), undefined);
}

/** Runs `body` with `BETTER_AUTH_SECRET` set to `value`, or unset for undefined. */
function withSecret(value: string | undefined, body: () => Promise<void>) {
  const original = process.env.BETTER_AUTH_SECRET;
  if (value === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = value;
  return body().finally(() => {
    if (original === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = original;
  });
}

beforeAll(async () => {
  admin = postgres(adminUrlFor("postgres"), { max: 1, connect_timeout: 5 });
  await admin.unsafe(`DROP DATABASE IF EXISTS "${DB_NAME}"`);
  await admin.unsafe(`CREATE DATABASE "${DB_NAME}"`);
  await admin.end();

  client = postgres(adminUrlFor(DB_NAME), { max: 2, connect_timeout: 5 });
  await migrate(drizzle(client), { migrationsFolder: "./db/migrations" });

  // Point the SHIPPED instance at THIS database before its lazy client resolves.
  process.env.DATABASE_URL = adminUrlFor(DB_NAME);

  // The honest session. The FORGED cookie below reuses this exact token, so the
  // only difference between accepted and refused is the signing key — which is
  // the whole point of the negative control.
  const db = drizzle(client, { schema: authSchema });
  const userId = crypto.randomUUID();
  sessionToken = crypto.randomUUID();
  await db.insert(authSchema.user).values({
    id: userId,
    name: "T19 Forge",
    email: EMAIL,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(authSchema.session).values({
    id: crypto.randomUUID(),
    token: sessionToken,
    userId,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}, 120_000);

afterAll(async () => {
  if (ambientDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ambientDatabaseUrl;

  // The shipped instance opened its OWN pooled connection to this throwaway
  // database through `getDb()`, and Postgres refuses to drop a database that
  // still has sessions — so that pool must be closed first. Without this the six
  // assertions pass and the suite then fails in teardown, leaving a stray
  // `devloop_t19_forge_*` database behind.
  const { closeDb } = await import("../../src/lib/db/client");
  await closeDb();

  await client?.end();
  const cleanup = postgres(adminUrlFor("postgres"), {
    max: 1,
    connect_timeout: 5,
  });
  await cleanup.unsafe(`DROP DATABASE IF EXISTS "${DB_NAME}"`);
  await cleanup.end();
});

describe("the session helper refuses a forged session (D5)", () => {
  it("refuses to answer at all when BETTER_AUTH_SECRET is missing", async () => {
    const name = await sessionCookieName();
    requestCookieHeader = await serializeSignedCookie(
      name,
      sessionToken,
      REAL_SECRET,
    );

    await withSecret(undefined, async () => {
      // Even the HONEST cookie is refused: the helper has no signing key, so it
      // cannot verify anything, and reporting "signed out" would be a guess.
      await expect(getSession()).rejects.toThrow(AuthSecretMissingError);
      await expect(isSignedIn()).rejects.toThrow(AuthSecretMissingError);
    });
  });

  it("refuses when BETTER_AUTH_SECRET is Better Auth's published default", async () => {
    const name = await sessionCookieName();
    requestCookieHeader = await serializeSignedCookie(
      name,
      sessionToken,
      REAL_SECRET,
    );

    await withSecret(PUBLISHED_DEFAULT, async () => {
      await expect(getSession()).rejects.toThrow(AuthSecretMissingError);
      await expect(getSession()).rejects.toThrow(/published default secret/);
    });
  });

  /**
   * THE LOAD-BEARING CASE, and the shape QA's probe used.
   *
   * With a real secret configured, the same session token presented in a cookie
   * signed with the PUBLISHED DEFAULT key must NOT resolve. If this passes only
   * because the cookie format is wrong, it is decorative — so the next case
   * asserts the honest cookie for the SAME token IS accepted, which is what makes
   * "the forge was refused" a statement about the key rather than about parsing.
   */
  it("does not accept a session cookie signed with the published default", async () => {
    const name = await sessionCookieName();
    requestCookieHeader = await serializeSignedCookie(
      name,
      sessionToken,
      PUBLISHED_DEFAULT,
    );

    await withSecret(REAL_SECRET, async () => {
      const session = await getSession();
      expect(session).toBeNull();
      expect(await isSignedIn()).toBe(false);
    });
  });

  it("does not accept a session cookie signed with an unrelated key", async () => {
    const name = await sessionCookieName();
    requestCookieHeader = await serializeSignedCookie(
      name,
      sessionToken,
      "an-attacker-chosen-key",
    );

    await withSecret(REAL_SECRET, async () => {
      expect(await getSession()).toBeNull();
    });
  });

  /**
   * The control the whole file rests on. Same token, same cookie name, same
   * database row — signed with the real secret, it MUST resolve, and it must
   * resolve to THIS user. Without this, "everything is refused" would satisfy
   * every case above and the file would certify a permanently signed-out app.
   */
  it("accepts the honest session once a real secret is configured", async () => {
    const name = await sessionCookieName();
    requestCookieHeader = await serializeSignedCookie(
      name,
      sessionToken,
      REAL_SECRET,
    );

    await withSecret(REAL_SECRET, async () => {
      const session = await getSession();
      expect(session).not.toBeNull();
      expect(session?.user.email).toBe(EMAIL);
      expect(await isSignedIn()).toBe(true);

      // And the row really is the one the cookie names, read from Postgres rather
      // than from anything the instance returned.
      const rows = await client<Array<{ token: string }>>`
        SELECT "token" FROM "session" WHERE "userId" = (
          SELECT "id" FROM "user" WHERE "email" = ${EMAIL})`;
      expect(rows.map((row) => row.token)).toEqual([sessionToken]);
    });
  });

  it("reports no session for a request that carries no cookie at all", async () => {
    requestCookieHeader = undefined;

    await withSecret(REAL_SECRET, async () => {
      expect(await getSession()).toBeNull();
      expect(await isSignedIn()).toBe(false);
    });
  });

  /**
   * THE BACKSTOP, for the bypass the helper-level guard cannot close.
   *
   * `auth.api.getSession` is Better Auth's own API and is reachable directly, so a
   * check that lives only in `getSession()` leaves that path unguarded — which is
   * exactly what QA's round-3 probe did, and it reported
   * `FORGED-WITH-PUBLISHED-DEFAULT ACCEPTED: true`. The shipped instance therefore
   * never signs with the published default: with no secret configured it uses a
   * per-process random key instead, so a default-signed cookie cannot verify.
   *
   * Read through an indirection on purpose. `auth.options.secret` is statically
   * typed, so naming it directly would make DELETING the option a typecheck error
   * and the negative control would never reach a runtime assertion — a red
   * typecheck proves the option is referenced, not that it is safe. The lookup
   * keeps the assertion about behaviour.
   *
   * Note what this does NOT assert: that the shipped option throws. It cannot —
   * `betterAuth` initialises its context eagerly, so a throwing value would
   * reject `$context` at import and permanently poison it. That was implemented,
   * measured and reverted; the refusal lives in the consumers instead.
   */
  it("the shipped instance never signs with the published default", async () => {
    const optionsSecret = () =>
      (auth.options as unknown as Record<string, unknown>).secret as string;

    // Captured at construction: the shipped instance is built once, at import,
    // which is when the env is whatever the process was started with. So this
    // asserts on THAT value rather than pretending it re-reads the variable. The
    // env-based refusals above are the ones that must react to a change.
    expect(optionsSecret()).toBe(REAL_SECRET);

    // The property that matters, stated directly: whatever was captured, it is
    // not the published default that made a forged cookie verify.
    expect(optionsSecret()).not.toBe(PUBLISHED_DEFAULT);
  });

  /**
   * What the shipped instance is built with when the process starts with NO
   * secret — the actual default path, in a process of its own so the module-scope
   * capture above is not reused.
   *
   * This is where the published default would otherwise land, and it is why the
   * option exists at all. Asserted in a child process rather than by mutating
   * `process.env`, because the shipped value is captured once at import and
   * mutating the variable afterwards cannot change it — a test written that way
   * would pass for reasons that have nothing to do with the defect.
   */
  it("an unconfigured process signs with a random key, not the published default", async () => {
    const script = `
      import { auth } from ${JSON.stringify("./src/lib/auth.ts")};
      const ctx = await auth.$context;
      console.log(JSON.stringify({ secret: ctx.secret }));
      process.exit(0);
    `;

    // Synchronous on purpose: this is a fast in-process assertion about module
    // initialisation, not a test about waiting.
    const child = spawnSync("bun", ["-e", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        // The whole point: no secret in this environment.
        BETTER_AUTH_SECRET: "",
        AUTH_SECRET: "",
        DATABASE_URL: adminUrlFor(DB_NAME),
      },
    });
    expect(child.status, child.stderr).toBe(0);

    const line = child.stdout
      .split("\n")
      .map((text) => text.trim())
      .find((text) => text.startsWith("{"));
    expect(line, `child printed no result: ${child.stdout}`).toBeDefined();

    const parsed = JSON.parse(line as string) as { secret: string };
    expect(parsed.secret).not.toBe(PUBLISHED_DEFAULT);
    expect(parsed.secret).toMatch(/^devloop-unconfigured-/);
  });

  /**
   * THE CONTROL FOR THE WHOLE FILE, and the case that answers "would the helper
   * have refused anyway?".
   *
   * An auth instance with NO secret resolves Better Auth's published default as
   * its signing key. A cookie forged with that same default, for this file's real
   * session token, is therefore ACCEPTED by it — QA measured exactly this against
   * the shipped instance (`FORGED-WITH-PUBLISHED-DEFAULT ACCEPTED: true`).
   *
   * `getSession()` is what makes the difference, and it refuses BEFORE any of this
   * is reachable. So the two facts sit side by side on purpose: unguarded, the
   * forge works; guarded, the forge is refused and the honest session still
   * resolves. A suite that only asserted the refusal could not tell DevLoop's
   * check apart from the signing key happening to differ, and this is the case
   * that tells them apart.
   */
  it("an unconfigured instance WOULD accept the default-signed forge", async () => {
    // The env MUST be cleared here, not just the instance's own secret: Better
    // Auth resolves `options.secret || env.BETTER_AUTH_SECRET`, and an empty
    // `options.secret` is falsy, so it falls through to the ambient variable —
    // which this file set to REAL_SECRET. Leaving it set produces an instance
    // signing with REAL_SECRET, not the published default, and the control would
    // measure the wrong thing. Measured, not assumed: with the env left in place
    // this asserted `ctx.secret === PUBLISHED_DEFAULT` and got REAL_SECRET back.
    await withSecret(undefined, async () => {
      const unguarded = unconfiguredAuth();
      const name = await sessionCookieName();
      const forgedDefault = await serializeSignedCookie(
        name,
        sessionToken,
        PUBLISHED_DEFAULT,
      );

      const ctx = await unguarded.$context;
      expect(ctx.secret).toBe(PUBLISHED_DEFAULT);

      // And it accepts the forge. This assertion is expected to PASS: it is the
      // defect the guard exists to stop, reproduced deliberately. If Better Auth
      // ever stops falling back to the default, this goes red and the guard's
      // necessity should be re-derived rather than assumed.
      requestCookieHeader = forgedDefault;
      const accepted = await unguarded.api.getSession({
        headers: new Headers({ cookie: forgedDefault }),
      });
      expect(accepted?.user.email).toBe(EMAIL);
    });

    // The guarded helper, on that same cookie, refuses. `BETTER_AUTH_SECRET` is
    // the real secret here, so this is not the "no secret configured" refusal —
    // it is the library refusing a signature that does not match its key.
    requestCookieHeader = await serializeSignedCookie(
      await sessionCookieName(),
      sessionToken,
      PUBLISHED_DEFAULT,
    );
    await withSecret(REAL_SECRET, async () => {
      expect(await getSession()).toBeNull();
    });
  });
});
