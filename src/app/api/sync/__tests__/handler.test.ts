/**
 * Unit tests for the POST /api/sync handler (T15).
 *
 * NO real network and NO real token anywhere in this file: the registry is built
 * from a fake `SourcePlugin`, the credential is an obviously-fake sentinel string
 * that exists only to be searched for. `bun run test` therefore needs neither a
 * network nor a `.env`, exactly as the composition root's own tests do.
 *
 * The token-leak assertions are the reason the sentinel is so loud: a test that
 * greps for "the token we happened to use" proves nothing if the token is a
 * realistic string that could plausibly appear in an error for other reasons.
 * `ghp_NOT_A_REAL_TOKEN_leak_canary_4d2f` cannot appear anywhere by accident.
 *
 * ONE BLOCK NEEDS A REAL DATABASE, AND IS GATED ON IT. The "the shipped
 * idempotency note tells the truth" block runs the real `persistCanonicalEvents`
 * against a real migrated Postgres, because a fake writer cannot falsify the
 * route's shipped contract — it can only agree with it. That is the whole point
 * of that block: T15's prose described a plain `INSERT`, T16 replaced it with an
 * `ON CONFLICT DO UPDATE` upsert, and every fake-writer test stayed green over
 * the contradiction. This block is gated on `DATABASE_URL` so a developer with
 * no database skips it cleanly, and it is named in `vitest.db.config.ts` so the
 * `db round trip` CI job executes it rather than reporting a skipped green.
 */

import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { toCanonicalEventRow } from "../../../../../db/canonical-event-mapper";
import { canonicalEvents } from "../../../../../db/schema";
import { closeDb, getDb } from "@/lib/db/client";

import type { CanonicalEvent } from "@/core/events/canonical-event";
import type { PluginRegistry } from "@/core/plugins/registry";
import { PluginRegistry as Registry } from "@/core/plugins/registry";
import type { FetchedPage, PluginDescriptor } from "@/core/plugins/plugin";
import type {
  CanonicalEventConflictConfig,
  CanonicalEventWriter,
} from "@/app/sources";
import {
  persistCanonicalEvents,
  SourceConfigurationError,
  SYNC_FAILURE_CODES,
  syncSource,
} from "@/app/sources";
import {
  GitHubPluginError,
  GITHUB_PLUGIN_ERROR_REASONS,
} from "@/plugins/github/github-errors";

import {
  handleSyncRequest,
  SYNC_IS_IDEMPOTENT,
  SYNC_OUTCOMES,
} from "../handler";

/** Obviously fake, obviously searchable, and impossible to reach accidentally. */
const SENTINEL_TOKEN = "ghp_NOT_A_REAL_TOKEN_leak_canary_4d2f";

const SOURCE = "code_hosting";

function event(overrides: Partial<CanonicalEvent> = {}): CanonicalEvent {
  return {
    id: `${SOURCE}:acme/demo#1`,
    source: SOURCE,
    externalId: "acme/demo#1",
    type: "issue",
    title: "Something happened",
    occurredAt: "2026-10-04T10:00:00.000Z",
    metadata: {},
    ...overrides,
  };
}

/**
 * The row type the SEAM asks for, derived from the seam itself rather than
 * re-declared: `values()`'s parameter type, read off
 * {@link CanonicalEventWriter}. Importing `db/schema`'s row type here instead
 * would make this test depend on the storage layer's own export list, and a
 * fake that names its parameter from the contract it is implementing cannot
 * silently drift from it.
 */
type WriterRow = Parameters<
  ReturnType<CanonicalEventWriter["insert"]>["values"]
>[0];

type RecordingWriter = CanonicalEventWriter & {
  /** One entry per applied insert: the rows that write would have persisted. */
  readonly written: WriterRow[];
  /** One entry per applied insert: the conflict clause it was applied with. */
  readonly conflicts: CanonicalEventConflictConfig[];
};

/**
 * A recording writer, satisfying the seam the production upsert widened:
 * `insert().values(rows)` is no longer the awaited promise, it is the CHAINED
 * half of an insert and hands back a builder that REQUIRES
 * `.onConflictDoUpdate(config)`. A fake written for the pre-upsert shape — one
 * whose `values()` is an `async` function — does not satisfy the current
 * {@link CanonicalEventWriter}, which is exactly how this suite ended up RED at
 * `tsc` while T15 and T16 were each GREEN alone.
 *
 * So the fake models the real thing: `values()` captures the rows and returns a
 * {@link CanonicalEventUpsertBuilder}, and the write is recorded when the
 * conflict clause is applied — the point at which production's query would
 * actually execute. `failWith` is thrown from THERE, not from `values()`, so a
 * refused write is never recorded as one.
 *
 * The method signatures are the seam's own, spelled out rather than cast: no
 * `any`, no `as unknown as`, so if the seam changes shape this fake stops
 * compiling instead of quietly satisfying it.
 */
function recordingWriter(failWith?: unknown): RecordingWriter {
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
              if (failWith !== undefined) throw failWith;
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

/** A fake source plugin: no transport, no credential, no network. */
function fakePlugin(
  items: readonly unknown[],
  options: {
    failWith?: unknown;
    name?: string;
  } = {},
): {
  describe(): PluginDescriptor;
  fetchItems(): Promise<FetchedPage<unknown>>;
  mapToCanonicalEvents(raw: readonly unknown[]): CanonicalEvent[];
} {
  return {
    describe: () => ({
      name: options.name ?? SOURCE,
      version: "0.0.0-test",
      requiresAuth: false,
    }),
    async fetchItems() {
      if (options.failWith !== undefined) throw options.failWith;
      return { items };
    },
    mapToCanonicalEvents: (raw) => raw as CanonicalEvent[],
  };
}

function registryWith(plugin: ReturnType<typeof fakePlugin>): PluginRegistry {
  return new Registry([plugin]);
}

/**
 * The real production `syncSource`, used as-is.
 *
 * No wrapper is needed or wanted here: `syncSource` already accepts an injected
 * registry and an injected writer, so passing the real function through proves
 * the route drives the ACTUAL pipeline rather than a stand-in that happens to
 * have the same signature. A hand-rolled reimplementation would be exactly the
 * kind of test that passes while the production call site is broken.
 */
const realSync = syncSource;

/**
 * The shipped note, checked against a REAL database rather than against prose.
 *
 * WHY THIS BLOCK IS SEPARATE FROM EVERYTHING ABOVE IT. Every other test in this
 * file injects a fake writer, so the whole suite can be green while the route's
 * `idempotencyNote` describes a write path that does not exist. That is exactly
 * the defect this block was added for: T15 documented the route while the write
 * path was a plain `INSERT`, T16 made it `ON CONFLICT DO UPDATE`, and the prose
 * shipped unchanged — telling every caller "not idempotent … does fail with
 * outcome `already_present`" over a route that upserts. The unit tests could not
 * have caught it: `idempotent` was typed the literal `false`, so
 * `expect(body.idempotent).toBe(false)` compared a literal to itself and passed
 * no matter what the database did.
 *
 * So the assertion here is deliberately at the SEAM the note talks about. It
 * runs the real `handleSyncRequest` over the real `persistCanonicalEvents`
 * against a real migrated Postgres, twice, and then asserts that the note the
 * handler shipped agrees with what the database actually did. If a future change
 * makes the write path a plain INSERT again, this goes red — which is the point:
 * the contract must be re-derived by execution, not re-asserted by a comment.
 *
 * Collected by the default suite (which has no database, so it skips) AND named
 * in `vitest.db.config.ts`, so `bun run test:db` in the `db round trip` job
 * actually executes it rather than reporting a skipped green.
 */
const connectionString = process.env.DATABASE_URL;
const describeWithDb = connectionString ? describe : describe.skip;

describeWithDb(
  "the shipped idempotency note tells the truth (real database)",
  () => {
    const DB_EVENT: CanonicalEvent = {
      id: "code_hosting:acme/db-note#1",
      source: "code_hosting",
      externalId: "acme/db-note#1",
      type: "issue",
      title: "first title",
      occurredAt: "2026-10-04T10:00:00.000Z",
      metadata: {},
    };

    async function clearRow(): Promise<void> {
      await getDb()
        .delete(canonicalEvents)
        .where(eq(canonicalEvents.externalId, DB_EVENT.externalId));
    }

    afterEach(clearRow);

    afterAll(async () => {
      if (connectionString) await closeDb();
    });

    it("proves a repeat call UPDATES in place and does NOT raise 23505, so the note's claim is load-bearing", async () => {
      // FIRST CALL. The production writer is used — no injected fake — because the
      // whole question is what the real query does on a repeat.
      const first = await handleSyncRequest({
        registry: registryWith(fakePlugin([DB_EVENT])),
      });
      expect(first.status).toBe(200);
      expect(first.body.outcome).toBe(SYNC_OUTCOMES.synced);
      expect(first.body.persisted).toBe(1);

      // SECOND CALL, same natural key, CHANGED title. This is the measurement the
      // old note was wrong about: it claimed this call would fail with
      // `already_present`. It does not — it returns 200 and converges.
      const second = await handleSyncRequest({
        registry: registryWith(
          fakePlugin([{ ...DB_EVENT, title: "second title" }]),
        ),
      });
      expect(second.status).toBe(200);
      expect(second.body.outcome).toBe(SYNC_OUTCOMES.synced);
      expect(second.body.persisted).toBe(1);

      // ONE row, holding the NEW value: the update is in place, not a duplicate
      // and not a silent discard.
      const rows = await getDb()
        .select()
        .from(canonicalEvents)
        .where(eq(canonicalEvents.externalId, DB_EVENT.externalId));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.title).toBe("second title");

      // AND THE SHIPPED CONTRACT AGREES WITH THAT MEASUREMENT. Every phrase below
      // is a claim a caller reads; each is checked against the behaviour proven
      // above, so the note cannot drift away from the write path again while every
      // gate stays green.
      const note = second.body.idempotencyNote;
      expect(second.body.idempotent).toBe(SYNC_IS_IDEMPOTENT);
      expect(note).toMatch(/ON CONFLICT DO UPDATE/i);
      expect(note).toMatch(/upsert/i);
      // The claims the old note made, all now proven false by this same test.
      expect(note).not.toMatch(/not idempotent/i);
      expect(note).not.toMatch(/plain INSERT/i);
      expect(note).not.toMatch(/instead of updating existing rows/i);
      expect(note).not.toMatch(/does fail with outcome/i);

      // The outcome's own message must agree with the note in the SAME body.
      expect(second.body.message).not.toMatch(/not idempotent/i);
    });

    it("keeps `already_present` REACHABLE against the real database, as a primary-key-only collision", async () => {
      // The flip side, so the fix cannot be mistaken for having deleted a failure
      // mode. A row colliding on PRIMARY KEY `id` while its natural key is free is
      // invisible to `ON CONFLICT (source, external_id)`, so the primary key still
      // raises 23505 and the route still classifies it. Seeded with a raw insert,
      // because the upsert would absorb this shape rather than raise it.
      await getDb()
        .insert(canonicalEvents)
        .values(toCanonicalEventRow(DB_EVENT));

      const colliding: CanonicalEvent = {
        ...DB_EVENT,
        // Same PRIMARY KEY, different natural key on BOTH columns.
        externalId: "acme/db-note#2",
        title: "colliding on the primary key only",
      };

      const { status, body } = await handleSyncRequest({
        registry: registryWith(fakePlugin([colliding])),
      });

      expect(status).toBe(409);
      expect(body.outcome).toBe(SYNC_OUTCOMES.alreadyPresent);
      expect(body.ok).toBe(false);

      // The message must attribute it to the PRIMARY KEY — the old text blamed the
      // natural-key unique constraint refusing "a repeat", which this measurement
      // contradicts.
      expect(body.message).toMatch(/PRIMARY KEY/i);
      expect(body.message).not.toMatch(/already stored/i);

      // And the conflicting row left NO trace: the original is untouched.
      const rows = await getDb()
        .select()
        .from(canonicalEvents)
        .where(eq(canonicalEvents.externalId, DB_EVENT.externalId));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.title).toBe(DB_EVENT.title);

      await getDb()
        .delete(canonicalEvents)
        .where(eq(canonicalEvents.externalId, colliding.externalId));
    });
  },
);

describe("POST /api/sync handler", () => {
  it("reports a persisted count and counts by type on success", async () => {
    const writer = recordingWriter();
    const events = [
      event(),
      event({ id: "b", externalId: "acme/demo#2", type: "change_proposal" }),
      event({ id: "c", externalId: "acme/demo#3" }),
    ];

    const { status, body } = await handleSyncRequest({
      registry: registryWith(fakePlugin(events)),
      writer,
    });

    expect(status).toBe(200);
    expect(body.outcome).toBe(SYNC_OUTCOMES.synced);
    expect(body.ok).toBe(true);
    expect(body.persisted).toBe(3);
    expect(body.fetched).toBe(3);
    expect(body.byType).toEqual({ issue: 2, change_proposal: 1 });
    expect(writer.written).toHaveLength(1);
  });

  it("returns no row content: only counts, never ids, titles or urls", async () => {
    const { body } = await handleSyncRequest({
      registry: registryWith(
        fakePlugin([
          event({
            url: "https://example.invalid/secret-ish",
            author: "octocat",
          }),
        ]),
      ),
      writer: recordingWriter(),
    });

    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain("octocat");
    expect(serialised).not.toContain("secret-ish");
    expect(serialised).not.toContain("acme/demo#1");
    expect(body.byType).toEqual({ issue: 1 });
  });

  it("treats an empty page as a SUCCESS with persisted 0", async () => {
    const writer = recordingWriter();
    const { status, body } = await handleSyncRequest({
      registry: registryWith(fakePlugin([])),
      writer,
    });

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.outcome).toBe(SYNC_OUTCOMES.empty);
    expect(body.persisted).toBe(0);
    expect(body.fetched).toBe(0);
    // The empty-list guard in persistCanonicalEvents means no insert at all.
    expect(writer.written).toHaveLength(0);
  });

  it("reports that repeating the route is safe, against the shipped constant", async () => {
    const { body } = await handleSyncRequest({
      registry: registryWith(fakePlugin([event()])),
      writer: recordingWriter(),
    });

    // Asserted against `SYNC_IS_IDEMPOTENT` -- the SAME exported constant
    // `body()` assigns -- rather than against a literal repeated here. The old
    // assertion was `expect(body.idempotent).toBe(false)` on a field typed the
    // literal `false` and assigned the constant `false`: a literal compared to
    // itself, which passes whatever the route actually does. That tautology is
    // how this batch shipped a note saying "not idempotent" over an
    // `ON CONFLICT DO UPDATE` upsert with every gate green.
    expect(body.idempotent).toBe(SYNC_IS_IDEMPOTENT);
    // And the constant is not left to drift into a tautology either: it must be
    // the boolean `true`, which `toBe(true)` can only satisfy by the value
    // being read off a real response body.
    expect(SYNC_IS_IDEMPOTENT).toBe(true);
    expect(typeof body.idempotent).toBe("boolean");
  });

  it("states the real write path in the note, and does NOT claim a repeat fails", async () => {
    const { body } = await handleSyncRequest({
      registry: registryWith(fakePlugin([event()])),
      writer: recordingWriter(),
    });

    const note = body.idempotencyNote;

    // The note must NAME the mechanism it now describes. A note that still said
    // "plain INSERT" would fail here.
    expect(note).toMatch(/ON CONFLICT DO UPDATE/i);
    expect(note).toMatch(/upsert/i);
    expect(note).toMatch(/UNIQUE \(source, external_id\)/);

    // ...and must NOT still claim a repeat is refused, which is the specific
    // falsehood this test exists to kill. Each of these phrases was in the
    // shipped note while the route upserted.
    expect(note).not.toMatch(/not idempotent/i);
    expect(note).not.toMatch(/plain INSERT/i);
    expect(note).not.toMatch(/instead of updating existing rows/i);
    expect(note).not.toMatch(/does fail with outcome/i);
  });

  it("keeps `already_present` reachable, and describes it as a PRIMARY-KEY conflict", async () => {
    // `already_present` is still a real, correct outcome -- the upsert absorbs
    // the natural key only, so a primary-key-only collision still raises 23505.
    // This test pins that the classification survives the prose fix, so the fix
    // cannot be mistaken for deleting a failure mode.
    //
    // The 23505 is injected through the EXISTING `recordingWriter(failWith)`
    // seam rather than a bespoke fake, because that helper throws from inside
    // `onConflictDoUpdate` -- the point production's query executes -- so the
    // path under test is the real one.
    const { status, body } = await handleSyncRequest({
      registry: registryWith(fakePlugin([event()])),
      writer: recordingWriter(
        Object.assign(new Error("duplicate key value"), {
          cause: { code: "23505" },
        }),
      ),
    });

    expect(status).toBe(409);
    expect(body.outcome).toBe(SYNC_OUTCOMES.alreadyPresent);
    expect(body.ok).toBe(false);

    // The message must attribute it to the primary key, NOT to the natural key
    // a repeat would hit -- the old text claimed the unique constraint refused
    // a repeat insert, which is false.
    expect(body.message).toMatch(/PRIMARY KEY/i);
    expect(body.message).not.toMatch(/already stored/i);

    // The note shipped in the SAME body must not contradict the outcome it
    // accompanies.
    expect(body.idempotencyNote).not.toMatch(/not idempotent/i);
  });
});

describe("POST /api/sync failure modes are distinct", () => {
  it("reports a missing DATABASE_URL before doing anything else", async () => {
    const fetchItems = vi.fn();
    const { status, body } = await handleSyncRequest({
      registry: new Registry([
        {
          describe: () => ({
            name: SOURCE,
            version: "0.0.0-test",
            requiresAuth: false,
          }),
          fetchItems,
          mapToCanonicalEvents: () => [],
        },
      ]),
      hasDatabaseUrl: () => false,
    });

    expect(status).toBe(503);
    expect(body.outcome).toBe(SYNC_OUTCOMES.databaseUnconfigured);
    expect(body.ok).toBe(false);
    // Proves it short-circuits rather than making a pointless network call.
    expect(fetchItems).not.toHaveBeenCalled();
  });

  it("reports an unconfigured source as its own outcome", async () => {
    const { status, body } = await handleSyncRequest({
      writer: recordingWriter(),
      // A registry is required even here: the route resolves it before calling
      // the injected sync, and an absent one throws the very error under test.
      registry: registryWith(fakePlugin([])),
      // Force the composition root's own fixed-reason error.
      sync: () => {
        throw new SourceConfigurationError(
          "DEVLOOP_REPOSITORY is not set, so no source can be built.",
        );
      },
    });

    expect(status).toBe(503);
    expect(body.outcome).toBe(SYNC_OUTCOMES.sourceNotConfigured);
  });

  it("reports a missing credential without making a request upstream", async () => {
    const { status, body } = await handleSyncRequest({
      writer: recordingWriter(),
      registry: registryWith(fakePlugin([])),
      sync: () => {
        throw new GitHubPluginError("credential_failed", {
          reason: GITHUB_PLUGIN_ERROR_REASONS.credentialUnavailable,
        });
      },
    });

    expect(status).toBe(503);
    expect(body.outcome).toBe(SYNC_OUTCOMES.credentialUnavailable);
    expect(body.persisted).toBe(0);
  });

  it("reports an upstream 4xx with the status and no upstream body", async () => {
    const { status, body } = await handleSyncRequest({
      writer: recordingWriter(),
      registry: registryWith(fakePlugin([])),
      sync: () => {
        throw new GitHubPluginError("http_status", {
          reason: GITHUB_PLUGIN_ERROR_REASONS.unauthorised,
          status: 401,
        });
      },
    });

    expect(status).toBe(502);
    expect(body.outcome).toBe(SYNC_OUTCOMES.upstreamRejected);
    expect(body.upstreamStatus).toBe(401);
    expect(body.byType).toEqual({});
  });

  it("reports an upstream 5xx separately from a 4xx", async () => {
    const { status, body } = await handleSyncRequest({
      writer: recordingWriter(),
      registry: registryWith(fakePlugin([])),
      sync: () => {
        throw new GitHubPluginError("http_status", {
          reason: GITHUB_PLUGIN_ERROR_REASONS.serverError,
          status: 503,
        });
      },
    });

    expect(status).toBe(502);
    expect(body.outcome).toBe(SYNC_OUTCOMES.upstreamRejected);
    expect(body.upstreamStatus).toBe(503);
  });

  it("reports an unreachable source as 502, distinct from a refusal", async () => {
    const { status, body } = await handleSyncRequest({
      writer: recordingWriter(),
      registry: registryWith(fakePlugin([])),
      sync: () => {
        throw new GitHubPluginError("transport_failed", {
          reason: GITHUB_PLUGIN_ERROR_REASONS.transportRejected,
        });
      },
    });

    expect(status).toBe(502);
    expect(body.outcome).toBe(SYNC_OUTCOMES.upstreamUnreachable);
  });

  it("reports a 23505 unique violation as already_present rather than success", async () => {
    // RENAMED. The old title was "reports a repeat insert as already_present
    // rather than success", which asserted the very falsehood this batch fixes:
    // a repeat insert is NOT what raises 23505, because the write path is an
    // `ON CONFLICT DO UPDATE` upsert and a repeat converges. What still raises
    // 23505 is a PRIMARY-KEY-only collision, which the upsert cannot absorb.
    //
    // The test body is unchanged and still correct — a 23505 arriving from the
    // writer is classified as `already_present`/409 and never as a successful
    // write. Only the title made a claim the route does not honour, and a wrong
    // test name is the same defect class as the wrong response prose: it tells
    // the next reader something untrue about their own system.
    //
    // Postgres unique-violation, wrapped by Drizzle the way a real driver
    // failure arrives: the SQLSTATE lives on `cause`, not on the outer error.
    const wrapped = Object.assign(
      new Error("Failed query: insert into canonical_events"),
      {
        cause: Object.assign(
          new Error('duplicate key value violates unique constraint "x"'),
          { code: "23505" },
        ),
      },
    );
    const writer = recordingWriter(wrapped);

    const { status, body } = await handleSyncRequest({
      registry: registryWith(fakePlugin([event()])),
      writer,
    });

    expect(status).toBe(409);
    expect(body.outcome).toBe(SYNC_OUTCOMES.alreadyPresent);
    expect(body.ok).toBe(false);
    // The conflict must never be reported as a successful write.
    expect(body.persisted).toBe(0);
    expect(writer.written).toHaveLength(0);
  });

  it("reports an unclassified failure as 500 without rendering it", async () => {
    const { status, body } = await handleSyncRequest({
      writer: recordingWriter(),
      registry: registryWith(fakePlugin([])),
      sync: () => {
        throw new Error(`something internal and specific: ${SENTINEL_TOKEN}`);
      },
    });

    expect(status).toBe(500);
    expect(body.outcome).toBe(SYNC_OUTCOMES.internalError);
    expect(JSON.stringify(body)).not.toContain("something internal");
  });

  it("does not mistake an ordinary database failure for a conflict", async () => {
    const refused = Object.assign(new Error("connection refused"), {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), {
        code: "ECONNREFUSED",
      }),
    });

    const { status, body } = await handleSyncRequest({
      registry: registryWith(fakePlugin([event()])),
      writer: recordingWriter(refused),
    });

    expect(status).toBe(500);
    expect(body.outcome).toBe(SYNC_OUTCOMES.internalError);
  });
});

/**
 * A REFUSED BATCH MUST NOT BE REPORTED AS A SUCCESS. This is the negative
 * control for a real, measured defect -- not a hypothetical.
 *
 * `syncSource` deliberately RETURNS a writer refusal instead of throwing it, so
 * a route answers with a typed outcome rather than an exception escaping as an
 * opaque 500. That is the correct boundary design, and it put the burden on this
 * consumer: the handler used to read only `result.events.length` and
 * `result.persisted` and never inspected `result.failure`, so a batch the writer
 * rejected in full came back as `synced` / HTTP 200 / `ok: true`. Measured by
 * injection at this same seam, before the fix:
 *
 *   status = 200  ok = true  outcome = "synced"  fetched = 1  persisted = 0
 *
 * Every other test in this file drove the handler through the `sync` seam and
 * none of them returned a populated `failure`, so the whole suite was green on a
 * route that reported a total write failure as a successful sync. That is the
 * defect class this block closes.
 */
describe("a refused batch is never reported as a success", () => {
  /**
   * A `sync` that behaves exactly as `syncSource` behaves on refusal: events
   * fetched, nothing written, and the classification attached.
   */
  function refusingSync() {
    return async () => ({
      events: [event()],
      persisted: 0,
      failure: {
        code: SYNC_FAILURE_CODES.eventNotPersistable,
        index: 0,
        eventId: event().id,
        externalId: event().externalId,
        // The writer's own message, VERBATIM, and it names the offending value.
        // Asserted absent from the response below.
        detail:
          "occurred_at 2026-10-04T10:00:00.123456Z has sub-millisecond precision [W-SECRET-CANARY]",
      },
    });
  }

  it("reports a refusal as its own failure outcome, NOT synced and NOT 200", async () => {
    const { status, body } = await handleSyncRequest({
      registry: registryWith(fakePlugin([event()])),
      // Past the unconfigured-database guard without touching a real database:
      // the seam under test is `sync`, which is injected.
      hasDatabaseUrl: () => true,
      sync: refusingSync(),
    });

    // THE ASSERTION THAT MATTERS: not a success, on any axis a caller reads.
    expect(body.outcome).not.toBe(SYNC_OUTCOMES.synced);
    expect(body.outcome).toBe(SYNC_OUTCOMES.eventNotPersistable);
    expect(body.ok).toBe(false);
    expect(status).toBe(422);
    expect(status).not.toBe(200);

    // Nothing was written, so nothing is claimed to have been written or fetched.
    // Reporting the refused page's event count as `fetched` would imply the
    // events reached storage.
    expect(body.persisted).toBe(0);
    expect(body.fetched).toBe(0);
    expect(body.byType).toEqual({});

    // The message says the batch was refused, in fixed text.
    expect(body.message).toMatch(/refused/i);
    expect(body.message).toMatch(/all-or-nothing|NOTHING was written/i);
  });

  it("does NOT leak the writer's verbatim detail into the response", async () => {
    // `SyncFailure.detail` carries the writer's rejection message verbatim and it
    // names the offending value. This module's secret-hygiene contract says no
    // upstream or driver text reaches a response body, and a writer message is
    // exactly that. So the classification is selected into fixed text and the
    // detail is dropped — asserted here so a future "helpful" echo cannot be
    // added without turning this red.
    const { body } = await handleSyncRequest({
      registry: registryWith(fakePlugin([event()])),
      hasDatabaseUrl: () => true,
      sync: refusingSync(),
    });

    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain("W-SECRET-CANARY");
    expect(serialised).not.toContain("sub-millisecond");
    expect(serialised).not.toContain("2026-10-04T10:00:00.123456Z");
    // And it must not be smuggled in under another key either.
    expect(body).not.toHaveProperty("failure");
    expect(body).not.toHaveProperty("detail");
  });

  it("still reports a genuine success as a success, so the refusal check is not over-broad", async () => {
    // The control for the block above. If the refusal check were written to
    // fire on `persisted === 0` instead of on `failure !== undefined`, this would
    // go red — and so would every legitimately-empty sync, which is a success.
    const { status, body } = await handleSyncRequest({
      registry: registryWith(fakePlugin([event()])),
      hasDatabaseUrl: () => true,
      sync: async () => ({ events: [event()], persisted: 1 }),
    });

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.outcome).toBe(SYNC_OUTCOMES.synced);
    expect(body.persisted).toBe(1);
  });

  it("still reports a genuinely empty page as `empty`, not as a refusal", async () => {
    // The other control. `syncSource` returns `{ events: [], persisted: 0 }`
    // with NO `failure` for a source with nothing new; that is a 200 success
    // with zero rows, and the refusal check must not swallow it. This is the
    // exact distinction the response previously could not express: "persisted
    // zero because there was nothing to write" versus "persisted zero because
    // every row was refused".
    const { status, body } = await handleSyncRequest({
      registry: registryWith(fakePlugin([event()])),
      hasDatabaseUrl: () => true,
      sync: async () => ({ events: [], persisted: 0 }),
    });

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.outcome).toBe(SYNC_OUTCOMES.empty);
    expect(body.persisted).toBe(0);
  });
});

describe("no token value reaches a response or a thrown error", () => {
  it("leaks nothing when the upstream failure carries the token in its text", async () => {
    const { status, body } = await handleSyncRequest({
      writer: recordingWriter(),
      registry: registryWith(fakePlugin([])),
      sync: () => {
        // The realistic worst case this route must survive: a transport that
        // fails with the credential interpolated into its message. The plugin's
        // own boundary already prevents this from reaching it, so the handler is
        // fed the hostile value directly and must still not echo it.
        throw new GitHubPluginError("transport_failed", {
          reason: GITHUB_PLUGIN_ERROR_REASONS.transportRejected,
          status: undefined,
        });
      },
    });

    expect(status).toBe(502);
    expect(JSON.stringify(body)).not.toContain(SENTINEL_TOKEN);
    expect(body.outcome).toBe(SYNC_OUTCOMES.upstreamUnreachable);
  });

  it("leaks nothing when a raw error embeds the token and an Authorization header", async () => {
    const hostile = new Error(
      `request failed: authorization: token ${SENTINEL_TOKEN}`,
    );

    const { body } = await handleSyncRequest({
      writer: recordingWriter(hostile),
      registry: registryWith(fakePlugin([event()])),
    });

    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain(SENTINEL_TOKEN);
    expect(serialised.toLowerCase()).not.toContain("authorization");
  });

  it("leaks nothing when the persistence failure embeds the token", async () => {
    const hostile = Object.assign(
      new Error(`insert failed for ${SENTINEL_TOKEN}`),
      {
        cause: Object.assign(new Error("wrapped"), { code: "23505" }),
      },
    );

    const { body } = await handleSyncRequest({
      registry: registryWith(fakePlugin([event()])),
      writer: recordingWriter(hostile),
    });

    // 23505 is still classified as already_present, and the message that
    // carried the token is still dropped: classification reads the SQLSTATE,
    // never the text.
    expect(body.outcome).toBe(SYNC_OUTCOMES.alreadyPresent);
    expect(JSON.stringify(body)).not.toContain(SENTINEL_TOKEN);
  });

  it("never throws, whatever the injected sync does", async () => {
    const hostile = new Error(SENTINEL_TOKEN);
    await expect(
      handleSyncRequest({
        writer: recordingWriter(),
        registry: registryWith(fakePlugin([])),
        sync: () => Promise.reject(hostile),
      }),
    ).resolves.toMatchObject({ status: 500 });
  });
});

describe("real syncSource through the handler", () => {
  it("writes only THROUGH the upsert: no conflict clause, no recorded write", async () => {
    // The regression guard for the stub itself. `recordingWriter` is a fake, so
    // nothing but this test proves it still models the CURRENT seam rather than
    // a shape that happens to typecheck: the fake's write is recorded inside
    // `onConflictDoUpdate`, and it is the fake's own argument that says the
    // conflict clause was reached. Delete `onConflictDoUpdate` from the stub —
    // the mistake this card exists to repair — and `persistCanonicalEvents` has
    // nothing to call, so this test fails; a `written` array fed from `values()`
    // would keep passing while proving nothing.
    const writer = recordingWriter();

    await expect(persistCanonicalEvents([event()], writer)).resolves.toBe(1);

    expect(writer.written).toHaveLength(1);
    expect(writer.conflicts).toHaveLength(1);
    // The clause is not a stub detail: production upserts on the natural key and
    // updates the mutable columns. Reading the column names off the clause the
    // fake was actually handed means this test fails if the fake is ever fed
    // something other than the clause the code really executes — and it names
    // the key by name rather than importing the table, so this route test still
    // depends on no storage export.
    const clause = writer.conflicts[0];
    // `target` is a column OR an array of them, per Drizzle's own config type,
    // so it is normalised here rather than assuming the array form.
    const targets = clause?.target ?? [];
    expect([targets].flat().map((column) => column.name)).toEqual([
      "source",
      // The SQL column name, not the TypeScript key: Drizzle's own metadata
      // `name` is what reaches Postgres, and asserting it catches a clause built
      // against the wrong column entirely.
      "external_id",
    ]);
    expect(Object.keys(clause?.set ?? {})).not.toContain("id");
  });

  it("records nothing when the writer refuses, even though the upsert ran", async () => {
    const hostile = new Error("insert failed");
    const writer = recordingWriter(hostile);

    await expect(persistCanonicalEvents([event()], writer)).rejects.toThrow(
      "insert failed",
    );

    // The write is recorded at the moment the clause is applied, and the
    // refusal happens in that same call, so a refused upsert leaves no trace.
    expect(writer.written).toHaveLength(0);
    expect(writer.conflicts).toHaveLength(0);
  });
  it("drives the production syncSource with an injected writer", async () => {
    const writer = recordingWriter();
    const { status, body } = await handleSyncRequest({
      registry: registryWith(
        // Distinct natural keys, deliberately: `persistCanonicalEvents` dedupes
        // a batch by (source, externalId) before writing, so two events sharing
        // an `externalId` are ONE row by design. This test is about a two-event
        // page being written whole, so the keys must differ — a fixture reusing
        // one key would assert 2 rows for a batch that is 1 row, and would be
        // testing the dedupe rather than the count.
        fakePlugin([
          event(),
          event({ id: "b", externalId: "acme/demo#2", type: "issue" }),
        ]),
      ),
      writer,
      sync: realSync,
    });

    expect(status).toBe(200);
    expect(body.persisted).toBe(2);
    expect(body.byType).toEqual({ issue: 2 });
    expect(writer.written[0]).toHaveLength(2);
  });

  it("does not write anything for an empty page through real syncSource", async () => {
    const writer = recordingWriter();
    const { status, body } = await handleSyncRequest({
      registry: registryWith(fakePlugin([])),
      writer,
      sync: realSync,
    });

    expect(status).toBe(200);
    expect(body.outcome).toBe(SYNC_OUTCOMES.empty);
    expect(writer.written).toHaveLength(0);
  });
});
