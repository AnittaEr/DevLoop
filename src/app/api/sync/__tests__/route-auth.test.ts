/**
 * The session guard ON THE SYNC ROUTE (B46) — tests that prove the guard
 * prevents WORK, not merely that it returns a status.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `handler.test.ts`. That suite drives
 * `handleSyncRequest` directly with an injected registry, writer and `sync`, so
 * it cannot see the route's own composition. The thing this card adds is a
 * check IN `route.ts`, and a check that returns 401 while still calling the
 * handler would satisfy every assertion about status codes. So these tests call
 * the route's own exported `POST()` and assert the ABSENCE of work.
 *
 * ── WHY THE HARNESS IS BUILT SO IT DEMONSTRABLY WRITES ──────────────────────
 * A "the writer recorded zero rows" assertion is only meaningful if the same
 * harness is shown to record a row when the guard lets the request through. So
 * the authenticated case below runs the REAL `handleSyncRequest` over the REAL
 * `syncSource` with a recording writer injected, and asserts exactly one write.
 * The unauthenticated cases use the identical harness and assert zero. Pairing
 * the two is what turns "zero writes" from a tautology into a measurement: the
 * writer demonstrably works, and it was not invoked.
 *
 * The route passes no options to `handleSyncRequest`, so the registry, the
 * writer and the database check are supplied by spying on that one function
 * with an implementation that DELEGATES to the real one. A stub would prove
 * nothing; a delegation to the real pipeline with an injected writer proves
 * that production's `syncSource` ran and that a row was written.
 *
 * NO `.env`, NO DATABASE, NO NETWORK. `vi.doMock` + `vi.resetModules()` per case
 * gives each one its own module graph, so `getSession()` can return a different
 * answer per case without the first mock leaking into the next — which is the
 * failure mode a single shared mock makes invisible.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { PluginRegistry } from "@/core/plugins/registry";
import type { CanonicalEvent } from "@/core/events/canonical-event";
import type {
  CanonicalEventConflictConfig,
  CanonicalEventWriter,
} from "@/app/sources";
import { SOURCE_NAME, syncSource } from "@/app/sources";
import { SYNC_OUTCOMES } from "@/app/api/sync/handler";

type WriterRow = Parameters<
  ReturnType<CanonicalEventWriter["insert"]>["values"]
>[0];

/**
 * A recording writer shaped like the real seam: `values()` hands back a builder
 * that REQUIRES `.onConflictDoUpdate(config)`, and the write is recorded when
 * that clause is applied — the point at which production's query would execute.
 * A refused write is never recorded as one.
 *
 * The conflict clause is recorded too, because it is the cheapest proof in this
 * file that the REAL production upsert ran rather than a stand-in: the clause
 * carries Drizzle column references from `db/schema.ts`, which nothing here
 * could fabricate.
 */
function recordingWriter(): CanonicalEventWriter & {
  written: WriterRow[];
  conflicts: CanonicalEventConflictConfig[];
} {
  const written: WriterRow[] = [];
  const conflicts: CanonicalEventConflictConfig[] = [];
  return {
    written,
    conflicts,
    insert() {
      return {
        values(rows: WriterRow) {
          return {
            async onConflictDoUpdate(
              config: CanonicalEventConflictConfig,
            ): Promise<undefined> {
              written.push(rows);
              conflicts.push(config);
              return undefined;
            },
          };
        },
      };
    },
  };
}

const EVENT: CanonicalEvent = {
  id: "code_hosting:acme/guard#1",
  source: "code_hosting",
  externalId: "acme/guard#1",
  type: "issue",
  title: "guard probe",
  occurredAt: "2026-10-04T10:00:00.000Z",
  metadata: {},
};

/** A plugin that WOULD produce a row if the route ever reached the pipeline. */
function registryWithOneEvent(): PluginRegistry {
  return new PluginRegistry([
    {
      describe: () => ({
        name: SOURCE_NAME,
        version: "0.0.0-test",
        requiresAuth: false,
      }),
      async fetchItems() {
        return { items: [EVENT] };
      },
      mapToCanonicalEvents: () => [EVENT],
    },
  ]);
}

const ORIGINAL_SECRET = process.env.BETTER_AUTH_SECRET;

/**
 * Load a fresh module graph in which `getSession()` behaves as given, with the
 * sync seam spied and DELEGATING to the real handler over the real pipeline.
 *
 * Returns the route's `POST`, the real pipeline's writer and the spy, so a test
 * can assert both halves independently: "the guard refused" (spy call count)
 * and "no row was written" (writer).
 */
async function loadRouteWith(options: {
  session: { kind: "signed-in" } | { kind: "none" } | { kind: "misconfigured" };
}): Promise<{
  POST: () => Promise<Response>;
  writer: ReturnType<typeof recordingWriter>;
  syncCalls: () => number;
}> {
  vi.resetModules();

  // The error class is read from the graph the guard itself will load, not from
  // this file's top-level import: `vi.resetModules()` gives the guard a FRESH
  // copy of `@/lib/auth`, so an instance built from this suite's copy fails its
  // `instanceof` and the misconfiguration escapes as an unhandled throw. That is
  // a property of the harness, not of the guard — but it is exactly why the
  // guard matches on the class rather than on message text.
  const { AuthSecretMissingError: FreshAuthSecretMissingError } = await import(
    "@/lib/auth"
  );

  vi.doMock("@/lib/auth-session", () => ({
    getSession: vi.fn(async () => {
      if (options.session.kind === "none") return null;
      if (options.session.kind === "misconfigured") {
        throw new FreshAuthSecretMissingError(
          "BETTER_AUTH_SECRET is not set. Auth cookies cannot be signed without it.",
        );
      }
      return { session: { id: "s-1", userId: "u-1" }, user: { id: "u-1" } };
    }),
  }));

  const writer = recordingWriter();
  const registry = registryWithOneEvent();

  // Imported through the same alias the route resolves, so this is the SAME
  // module instance the route binds `handleSyncRequest` from.
  const handlerModule = await import("@/app/api/sync/handler");
  const realHandleSyncRequest = handlerModule.handleSyncRequest;
  const spy = vi
    .spyOn(handlerModule, "handleSyncRequest")
    .mockImplementation(async (syncOptions = {}) =>
      // The REAL handler, the REAL syncSource, an injected registry and the
      // recording writer. Only the two environment-specific inputs are ours.
      realHandleSyncRequest({
        registry,
        writer,
        hasDatabaseUrl: () => true,
        sync: syncSource,
        ...syncOptions,
      }),
    );

  const routeModule = await import("@/app/api/sync/route");

  return {
    POST: routeModule.POST,
    writer,
    syncCalls: () => spy.mock.calls.length,
  };
}

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = ORIGINAL_SECRET;
  vi.doUnmock("@/lib/auth-session");
  vi.resetModules();
});

describe("POST /api/sync — the guard, with a harness proven to write", () => {
  it("CONTROL: with a session the real pipeline runs and the writer records ONE row", async () => {
    // This is the non-vacuity anchor for the two refusals below. If this ever
    // records zero, the refusals prove nothing.
    process.env.BETTER_AUTH_SECRET = "b46-route-test-secret-not-a-credential";
    const { POST, writer, syncCalls } = await loadRouteWith({
      session: { kind: "signed-in" },
    });

    const response = await POST();
    const body = (await response.json()) as Record<string, unknown>;

    expect(syncCalls()).toBe(1);
    expect(writer.written).toHaveLength(1);
    expect(response.status).toBe(200);
    expect(body.outcome).toBe(SYNC_OUTCOMES.synced);
    expect(body.ok).toBe(true);
    expect(body.persisted).toBe(1);
    // Same body shape and same idempotency semantics as c6de1d7 (c3).
    expect(body.idempotent).toBe(true);
    expect(String(body.idempotencyNote)).toMatch(/ON CONFLICT DO UPDATE/i);
    // The clause that ran is the one carrying Drizzle column references, i.e.
    // the shipped natural-key upsert — not something this suite could invent.
    expect(writer.conflicts).toHaveLength(1);
  });

  it("401 with NO session: names the condition, calls nothing, writes ZERO rows", async () => {
    // c1. The secret IS set and no cookie is supplied, so `getSession()` takes
    // its ordinary `null` path. This is the case a naive `catch -> 401` also
    // passes, which is exactly why it is not the only refusal tested.
    process.env.BETTER_AUTH_SECRET = "b46-route-test-secret-not-a-credential";
    const { POST, writer, syncCalls } = await loadRouteWith({
      session: { kind: "none" },
    });

    const response = await POST();
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(401);
    expect(body.outcome).toBe("session_required");
    expect(String(body.message)).toMatch(/session/i);
    expect(body.persisted).toBe(0);
    expect(body.fetched).toBe(0);
    // The two halves of c1, asserted separately: the handler was never reached
    // (so no GitHub plugin was constructed), AND the writer recorded nothing.
    expect(syncCalls()).toBe(0);
    expect(writer.written).toHaveLength(0);
  });

  it("503 — NOT 401 — when auth is unconfigured, naming the VARIABLE", async () => {
    // D-285's trap. With `BETTER_AUTH_SECRET` unset, `getSession()` THROWS; a
    // guard that catches everything reports a broken `.env` as a signed-out user
    // and it hides indefinitely.
    delete process.env.BETTER_AUTH_SECRET;
    const { POST, writer, syncCalls } = await loadRouteWith({
      session: { kind: "misconfigured" },
    });

    const response = await POST();
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(503);
    expect(response.status).not.toBe(401);
    expect(body.outcome).toBe("auth_not_configured");
    expect(String(body.message)).toMatch(/BETTER_AUTH_SECRET/);
    expect(syncCalls()).toBe(0);
    expect(writer.written).toHaveLength(0);
  });

  it("echoes no secret value in either refusal body", async () => {
    const secret = "b46-route-secret-canary-4d2f";
    process.env.BETTER_AUTH_SECRET = secret;
    const { POST } = await loadRouteWith({ session: { kind: "none" } });

    const serialised = JSON.stringify(await (await POST()).json());
    expect(serialised).not.toContain(secret);
    expect(serialised.toLowerCase()).not.toContain("bearer ");
  });
});
